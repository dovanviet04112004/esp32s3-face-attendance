"""The one entry point that trains the detection branch.

Validation ranks epochs by average precision, not by the task loss: the loss
keeps falling after the detector has stopped finding the small faces that decide
whether this branch is usable at all.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader

from facepipe.core.config import Config, load_config
from facepipe.core.logger import RunLogger
from facepipe.core.metrics import MetricTracker
from facepipe.core.registry import LOSSES, MODELS
from facepipe.core.run_dir import create_run_dir
from facepipe.core.scheduler import build_optimizer, build_scheduler
from facepipe.core.seed import seed_everything
from facepipe.core.trainer import Trainer, resolve_device

from .data import CROP_SCALE, MIN_FACE_PX, WiderFaceDataset, collate
from .eval import average_precision, decode_batch

TASK_LOSS = "detection_task"


def prefetch(cfg: Config) -> dict[str, int]:
    """DataLoader rejects prefetch_factor when it has no workers to prefetch on."""
    return {"prefetch_factor": cfg.data.prefetch_factor} if cfg.data.num_workers > 0 else {}


def build_dataset(cfg: Config, split_index: int, train: bool) -> WiderFaceDataset:
    params = cfg.data.params
    return WiderFaceDataset(
        coco=Path(params["coco"]),
        images_root=Path(params["images"]),
        split_file=Path(cfg.data.split_files[split_index]),
        input_hw=tuple(cfg.model.input_hw),
        train=train,
        seed=cfg.run.seed,
        crop_scale=tuple(params.get("crop_scale", CROP_SCALE)),
        min_face_px=float(params.get("min_face_px", MIN_FACE_PX)),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cfg", type=Path, required=True)
    parser.add_argument("--set", nargs="*", default=[], metavar="KEY=VALUE")
    args = parser.parse_args(argv)

    cfg = load_config(args.cfg, args.set)
    seed_everything(cfg.run.seed, deterministic=cfg.run.deterministic)
    run = create_run_dir(cfg)
    logger = RunLogger(run.path, tensorboard=cfg.log.tensorboard, level=cfg.log.level)

    model = MODELS.build({"name": cfg.model.name, "params": cfg.model.params})
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

    criterion = LOSSES.get(TASK_LOSS)()

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

    # Order matters: a resume casts optimizer momentum onto whichever device it
    # finds the parameters on, and they start on the host.
    device = resolve_device(cfg.train.device)
    model.to(device)
    criterion.to(device)

    optimizer = build_optimizer(model, cfg.optim)
    scheduler = build_scheduler(optimizer, cfg.sched, len(loader), cfg.train.epochs)

    def step_fn(batch: tuple[torch.Tensor, object]) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
        images, targets = batch
        # trainer.model, not the module above: a compiled run must reach the
        # wrapper the trainer built, or the graph is traced twice.
        loss = criterion(trainer.model(images), targets)
        return loss, {"task": loss.detach(), "total": loss.detach()}

    @torch.no_grad()
    def val_fn(module: nn.Module, epoch: int) -> dict[str, float]:
        """Average precision on the held-out split, which is what picks the epoch.

        Not the task loss, which keeps falling after the detector has stopped
        finding faces.
        """
        module.eval()
        meter = MetricTracker()
        priors = val_loader.dataset.priors.to(trainer.device)
        predictions: list[np.ndarray] = []
        truth: list[np.ndarray] = []

        for batch in val_loader:
            images, targets = trainer.to_device(batch)
            out = module(images)
            meter.update({"loss": criterion(out, targets)}, n=1)
            for found, boxes in zip(decode_batch(out, priors), targets.gt_boxes, strict=True):
                predictions.append(
                    np.concatenate([found.boxes, found.scores[:, None]], axis=1)
                    if len(found.boxes)
                    else np.zeros((0, 5), np.float32)
                )
                truth.append(boxes.detach().cpu().numpy())
        return {**meter.means(), "ap": average_precision(predictions, truth)}

    trainer = Trainer(
        model=model,
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
    logger.info(f"images={len(train_set)}")
    trainer.fit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
