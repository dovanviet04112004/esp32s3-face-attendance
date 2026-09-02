"""The one entry point that trains the recognition student, teacher or not.

Both arms of KEHOACH section 3.7 run through here: A0 leaves teacher.enabled
false and gets ArcFace alone, A3 switches the cached teacher on and names its
distillation terms.

Validation is verification accuracy on LFW, CFP-FP and AgeDB-30, not the training
loss. ArcFace's loss falls steadily long after the embedding has stopped getting
better at deciding whether two unseen faces match, so a checkpoint picked by loss
is not the checkpoint that should ship.

Usage:
    python -m facepipe.tasks.recognition.train_kd \\
        --cfg configs/recognition/student_mobilefacenet.yaml
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import torch
from torch import nn
from torch.utils.data import DataLoader

from facepipe.core.config import Config, load_config
from facepipe.core.distiller import Distiller, DistillLossSet, StageSchedule, TeacherWrapper
from facepipe.core.logger import RunLogger
from facepipe.core.registry import LOSSES, MODELS, TEACHERS
from facepipe.core.run_dir import create_run_dir
from facepipe.core.scheduler import build_optimizer, build_scheduler
from facepipe.core.seed import seed_everything
from facepipe.core.trainer import Trainer, resolve_device

from .data import Ms1mShardDataset, RecogTargets, collate, normalize_batch, read_identities
from .eval import evaluate_all
from .losses import arcface  # noqa: F401  registers "recognition_arcface"
from .student import mobilefacenet  # noqa: F401  registers "mobilefacenet"
from .teacher import r50_wf600k  # noqa: F401  registers the teachers

TASK_LOSS = "recognition_arcface"
# The hardest of the three benchmarks, and the only one with room left: LFW runs
# to 99.8, where its 6,000 pairs put a tenth of a point at six pairs of noise.
BEST_METRIC = "cfp_fp_accuracy"


class CachedTeacherDistiller(Distiller):
    """Feeds the teacher the embeddings the loader read, not the images.

    The teacher's answers were computed once by export_embedding and travel with
    the batch, so what reaches it here is already its own output.
    """

    def teacher_inputs(self, inputs: Any, batch: Any) -> Any:
        if batch.teacher is None:
            raise ValueError("distilling without a teacher cache: set data.params.teacher_cache")
        return batch.teacher


def prefetch(cfg: Config) -> dict[str, int]:
    """DataLoader rejects prefetch_factor when it has no workers to prefetch on."""
    return {"prefetch_factor": cfg.data.prefetch_factor} if cfg.data.num_workers > 0 else {}


def crop_size(cfg: Config) -> int:
    """The size the loader feeds, taken from the one place it is declared."""
    height, width = cfg.model.input_hw
    if height != width:
        raise ValueError(f"model.input_hw must be square for this branch, got {height}x{width}")
    return int(height)


def build_dataset(cfg: Config, split_index: int, train: bool) -> Ms1mShardDataset:
    params = cfg.data.params
    cache = params.get("teacher_cache") if cfg.distill.enabled else None
    return Ms1mShardDataset(
        root=Path(params["shards"]),
        identities=read_identities(Path(cfg.data.split_files[split_index])),
        size=crop_size(cfg),
        train=train,
        seed=cfg.run.seed,
        teacher_cache=Path(cache) if cache else None,
        embedding_dim=int(params.get("embedding_dim", 512)),
    )


def build_loader(cfg: Config, dataset: Ms1mShardDataset, train: bool) -> DataLoader:
    # Shards arrive shuffled and the dataset holds a buffer back, so the loader
    # must not shuffle: an IterableDataset cannot be indexed anyway.
    return DataLoader(
        dataset,
        batch_size=cfg.data.batch_size,
        num_workers=cfg.data.num_workers,
        pin_memory=cfg.data.pin_memory,
        drop_last=cfg.data.drop_last if train else False,
        collate_fn=collate,
        **prefetch(cfg),
    )


def build_teacher(cfg: Config) -> TeacherWrapper | None:
    """Load the teacher only for the arms that distil from one."""
    if not cfg.teacher.enabled or cfg.teacher.name is None:
        return None
    return TeacherWrapper(TEACHERS.build({"name": cfg.teacher.name, "params": cfg.teacher.params}))


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
    loader = build_loader(cfg, train_set, train=True)
    benchmarks = Path(cfg.data.params["benchmarks"])

    factory = CachedTeacherDistiller if cfg.distill.enabled else Distiller
    distiller = factory(
        student=student,
        teacher=build_teacher(cfg),
        loss_set=DistillLossSet.from_config(cfg.distill) if cfg.distill.enabled else None,
        task_loss=LOSSES.get(TASK_LOSS)(
            num_classes=train_set.num_classes,
            embedding=int(cfg.model.params.get("embedding", 512)),
            **cfg.data.params.get("arcface", {}),
        ),
        task_loss_weight=cfg.distill.task_loss_weight,
        student_layers=cfg.distill.feature_layers or None,
        teacher_layers=None,
        schedule=StageSchedule(cfg.distill.stages) if cfg.distill.stages else None,
    )

    # The ArcFace centres and any KD projection are trainable and live in the
    # losses, not the student, so the optimizer is built over the whole distiller.

    # Order matters: a resume casts optimizer momentum onto whichever device it
    # finds the parameters on, and they start on the host.
    distiller.to(resolve_device(cfg.train.device))

    optimizer = build_optimizer(distiller, cfg.optim)
    scheduler = build_scheduler(optimizer, cfg.sched, len(loader), cfg.train.epochs)

    def step_fn(batch: tuple[torch.Tensor, RecogTargets]) -> tuple[torch.Tensor, dict]:
        images, targets = batch
        distiller.epoch = trainer.state.epoch
        train_set.epoch = trainer.state.epoch
        return distiller(normalize_batch(images), targets)

    def val_fn(module: nn.Module, epoch: int) -> dict[str, float]:
        """Verification accuracy on each benchmark, flattened for the logger."""
        scores = evaluate_all(module, benchmarks, trainer.device, batch_size=cfg.data.batch_size)
        return {f"{name}_{k}": v for name, values in scores.items() for k, v in values.items()}

    trainer = Trainer(
        model=student,
        optimizer=optimizer,
        scheduler=scheduler,
        train_loader=loader,
        cfg=cfg,
        run_dir=run,
        logger=logger,
        step_fn=step_fn,
        val_fn=val_fn,
        best_metric_key=BEST_METRIC,
        best_is_lower=False,
    )
    # The loss runs the student itself, so a compiled run has to reach the model
    # the trainer compiled rather than the one handed to the distiller.
    distiller.student = trainer.model
    logger.info(
        f"arm={'kd' if distiller.distilling else 'baseline'} "
        f"identities={train_set.num_classes} records={len(train_set)}"
    )
    trainer.fit()
    distiller.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
