"""The one entry point that trains the detection student, teacher or not.

All four arms of KEHOACH section 3.7 run through here. Which arm a run is comes
from the config alone: A0 leaves teacher.enabled false and gets the task loss,
A1 to A3 switch the teacher on and name their distillation terms. Splitting the
baseline into a second script would let augmentation, seed or schedule drift
between arms, and then the table measures the scripts rather than the method.

Usage:
    python -m facepipe.tasks.detection.train_kd --cfg configs/detection/student_yunet.yaml
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader

from facepipe.core.config import Config, load_config
from facepipe.core.distiller import Distiller, DistillLossSet, StageSchedule, TeacherWrapper
from facepipe.core.logger import RunLogger
from facepipe.core.metrics import MetricTracker
from facepipe.core.registry import LOSSES, MODELS
from facepipe.core.run_dir import create_run_dir
from facepipe.core.scheduler import build_optimizer, build_scheduler
from facepipe.core.seed import seed_everything
from facepipe.core.trainer import Trainer

from .data import CROP_SCALE, MIN_FACE_PX, WiderFaceDataset, collate
from .eval import average_precision, decode_batch

TASK_LOSS = "detection_task"


def prefetch(cfg: Config) -> dict[str, int]:
    """DataLoader rejects prefetch_factor when it has no workers to prefetch on."""
    return {"prefetch_factor": cfg.data.prefetch_factor} if cfg.data.num_workers > 0 else {}


def build_dataset(cfg: Config, split_index: int, train: bool) -> WiderFaceDataset:
    params = cfg.data.params
    store = None
    if cfg.distill.enabled and params.get("soft_targets"):
        from .teacher.export_soft_target import SoftTargetStore

        store = SoftTargetStore(Path(params["soft_targets"]))
    return WiderFaceDataset(
        coco=Path(params["coco"]),
        images_root=Path(params["images"]),
        split_file=Path(cfg.data.split_files[split_index]),
        input_hw=tuple(cfg.model.input_hw),
        train=train,
        soft_targets=store,
        seed=cfg.run.seed,
        crop_scale=tuple(params.get("crop_scale", CROP_SCALE)),
        min_face_px=float(params.get("min_face_px", MIN_FACE_PX)),
    )


def build_teacher(cfg: Config) -> TeacherWrapper | None:
    """Load the teacher only for the arms that distil from one."""
    if not cfg.teacher.enabled or cfg.teacher.name is None:
        return None
    from facepipe.core.registry import TEACHERS

    model = TEACHERS.build(
        {"name": cfg.teacher.name, "params": {"weights": cfg.teacher.ckpt, **cfg.teacher.params}}
    )
    return TeacherWrapper(model, freeze=cfg.teacher.freeze)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cfg", type=Path, required=True)
    parser.add_argument("--set", nargs="*", default=[], metavar="KEY=VALUE")
    args = parser.parse_args(argv)

    cfg = load_config(args.cfg, args.set)
    seed_everything(cfg.run.seed, deterministic=cfg.run.deterministic)
    run = create_run_dir(cfg)
    logger = RunLogger(run.path, tensorboard=cfg.log.tensorboard, level=cfg.log.level)

    student = MODELS.build({"name": cfg.model.name, "params": cfg.model.params})
    train_set = build_dataset(cfg, split_index=0, train=True)
    loader = DataLoader(
        train_set,
        batch_size=cfg.data.batch_size,
        shuffle=True,
        num_workers=cfg.data.num_workers,
        pin_memory=cfg.data.pin_memory,
        drop_last=cfg.data.drop_last,
        collate_fn=collate,
        **prefetch(cfg),
    )

    distiller = Distiller(
        student=student,
        teacher=build_teacher(cfg),
        loss_set=DistillLossSet.from_config(cfg.distill) if cfg.distill.enabled else None,
        task_loss=LOSSES.get(TASK_LOSS)(),
        task_loss_weight=cfg.distill.task_loss_weight,
        student_layers=cfg.distill.feature_layers or None,
        teacher_layers=cfg.distill.teacher_layers() or None,
        schedule=StageSchedule(cfg.distill.stages) if cfg.distill.stages else None,
    )

    val_loader = None
    if len(cfg.data.split_files) > 1:
        val_loader = DataLoader(
            build_dataset(cfg, split_index=1, train=False),
            batch_size=cfg.data.batch_size,
            shuffle=False,
            num_workers=cfg.data.num_workers,
            pin_memory=cfg.data.pin_memory,
            collate_fn=collate,
            **prefetch(cfg),
        )
    else:
        logger.warning("no second split file: no validation, and best.pth will not be written")

    # The FGD adapters are trainable and live in the loss, so the optimizer covers
    # the distiller; the frozen teacher drops out for lacking requires_grad.
    optimizer = build_optimizer(distiller, cfg.optim)
    scheduler = build_scheduler(optimizer, cfg.sched, len(loader), cfg.train.epochs)

    def step_fn(batch: tuple[torch.Tensor, object]) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
        images, targets = batch
        distiller.epoch = trainer.state.epoch
        return distiller(images, targets)

    @torch.no_grad()
    def val_fn(module: nn.Module, epoch: int) -> dict[str, float]:
        """Average precision on the held-out split, which is what picks the epoch.

        Not the task loss. Loss is a weighted sum of focal, IoU and landmark
        terms whose value means nothing outside this file, and it keeps falling
        after the detector has stopped finding more faces; a run selected on it
        ships a worse detector than one of its own earlier epochs.

        The distillation terms stay out of it either way: they are undefined
        without a teacher, so scoring them would make the two arms incomparable.
        """
        module.eval()
        meter = MetricTracker()
        priors = val_loader.dataset.priors.to(trainer.device)
        predictions: list[np.ndarray] = []
        truth: list[np.ndarray] = []

        for batch in val_loader:
            images, targets = trainer.to_device(batch)
            out = module(images)
            meter.update({"loss": distiller.task_loss(out, targets)}, n=1)
            for found, boxes in zip(decode_batch(out, priors), targets.gt_boxes, strict=True):
                predictions.append(
                    np.concatenate([found.boxes, found.scores[:, None]], axis=1)
                    if len(found.boxes)
                    else np.zeros((0, 5), np.float32)
                )
                truth.append(boxes.detach().cpu().numpy())
        return {**meter.means(), "ap": average_precision(predictions, truth)}

    trainer = Trainer(
        model=student,
        optimizer=optimizer,
        scheduler=scheduler,
        train_loader=loader,
        cfg=cfg,
        run_dir=run,
        logger=logger,
        step_fn=step_fn,
        val_fn=val_fn if val_loader is not None else None,
        best_metric_key="ap",
        best_is_lower=False,
    )
    # The trainer moves only the student; the teacher and the FGD adapters hang
    # off the distiller and would otherwise stay on the host.
    distiller.to(trainer.device)
    # The loss runs the student itself, so a compiled run has to reach the model
    # the trainer compiled rather than the one handed to the distiller.
    distiller.student = trainer.model
    logger.info(f"arm={'kd' if distiller.distilling else 'baseline'} images={len(train_set)}")
    trainer.fit()
    distiller.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
