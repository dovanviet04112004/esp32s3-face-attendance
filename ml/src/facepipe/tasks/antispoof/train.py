"""The one entry point that trains the anti-spoof branch.

Validation reports APCER and BPCER separately, not one accuracy: an attack that
gets in and a real face turned away cost different things on a door.
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

from .data import (
    CROP_SCALE_PROBABILITY,
    CROP_SCALE_RANGE,
    OCCLUSION_PROBABILITY,
    OCCLUSION_SIDE_RANGE,
    PHOTOMETRIC_PROBABILITY,
    QUALITY_RANGE,
    RECOMPRESS_PROBABILITY,
    ROLL_PROBABILITY,
    ROLL_RANGE,
    TRANSLATE_PROBABILITY,
    TRANSLATE_RANGE,
    SpoofShardDataset,
    collate,
)
from .eval import summary
from .losses import task_loss  # noqa: F401  registers "antispoof_task"
from .losses.task_loss import LIVE, SpoofBatch
from .model import minifasnet_v2_se  # noqa: F401  registers "minifasnet_v2_se"

TASK_LOSS = "antispoof_task"


def prefetch(cfg: Config) -> dict[str, int]:
    """DataLoader rejects prefetch_factor when it has no workers to prefetch on."""
    return {"prefetch_factor": cfg.data.prefetch_factor} if cfg.data.num_workers > 0 else {}


def crop_size(cfg: Config) -> int:
    """The size the loader feeds, taken from the one place it is declared.

    Each backbone ends in a depthwise kernel sized to the map a square input
    produces, so a rectangle would not reach that layer with the right shape.
    """
    height, width = cfg.model.input_hw
    if height != width:
        raise ValueError(f"model.input_hw must be square for this branch, got {height}x{width}")
    return int(height)


def build_dataset(cfg: Config, split: str, train: bool) -> SpoofShardDataset:
    params = cfg.data.params
    return SpoofShardDataset(
        root=Path(params["shards"]),
        size=crop_size(cfg),
        train=train,
        seed=cfg.run.seed,
        splits=split,
        recompress_probability=float(params.get("recompress_probability", RECOMPRESS_PROBABILITY)),
        quality_range=tuple(params.get("quality_range", QUALITY_RANGE)),
        photometric_probability=float(
            params.get("photometric_probability", PHOTOMETRIC_PROBABILITY)
        ),
        crop_scale_range=tuple(params.get("crop_scale_range", CROP_SCALE_RANGE)),
        crop_scale_probability=float(params.get("crop_scale_probability", CROP_SCALE_PROBABILITY)),
        occlusion_probability=float(params.get("occlusion_probability", OCCLUSION_PROBABILITY)),
        occlusion_side_range=tuple(params.get("occlusion_side_range", OCCLUSION_SIDE_RANGE)),
        roll_probability=float(params.get("roll_probability", ROLL_PROBABILITY)),
        roll_range=tuple(params.get("roll_range", ROLL_RANGE)),
        translate_probability=float(params.get("translate_probability", TRANSLATE_PROBABILITY)),
        translate_range=float(params.get("translate_range", TRANSLATE_RANGE)),
    )


def build_loader(cfg: Config, dataset: SpoofShardDataset, train: bool) -> DataLoader:
    # Shards already arrive shuffled and the dataset holds a buffer back, so the
    # loader must not shuffle: an IterableDataset cannot be indexed anyway.
    return DataLoader(
        dataset,
        batch_size=cfg.data.batch_size,
        num_workers=cfg.data.num_workers,
        pin_memory=cfg.data.pin_memory,
        drop_last=cfg.data.drop_last if train else False,
        collate_fn=collate,
        **prefetch(cfg),
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
    train_set = build_dataset(cfg, cfg.data.params.get("train_split", "train"), train=True)
    loader = build_loader(cfg, train_set, train=True)
    val_set = build_dataset(cfg, cfg.data.params.get("val_split", "valid"), train=False)
    val_loader = build_loader(cfg, val_set, train=False)

    criterion = LOSSES.get(TASK_LOSS)()

    # Order matters: a resume casts optimizer momentum onto whichever device it
    # finds the parameters on, and they start on the host.
    device = resolve_device(cfg.train.device)
    model.to(device)
    criterion.to(device)

    optimizer = build_optimizer(model, cfg.optim)
    scheduler = build_scheduler(optimizer, cfg.sched, len(loader), cfg.train.epochs)

    def step_fn(batch: tuple[torch.Tensor, ...]) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
        tight, wide, labels, wide_scale = batch
        train_set.epoch = trainer.state.epoch
        # trainer.model, not the module above: a compiled run must reach the
        # wrapper the trainer built, or the graph is traced twice.
        loss = criterion(trainer.model((tight, wide)), SpoofBatch(labels, wide_scale))
        return loss, {"task": loss.detach(), "total": loss.detach()}

    @torch.no_grad()
    def val_fn(module: nn.Module, epoch: int) -> dict[str, float]:
        """Task loss and the error rates at the threshold this split implies.

        APCER counts attacks accepted and BPCER live faces rejected, which cost
        different things on a door (KEHOACH 1.1). An argmax would pin the
        threshold at an even softmax split and rank by where scores sit.
        """
        module.eval()
        meter = MetricTracker()
        scores: list[np.ndarray] = []
        truth: list[np.ndarray] = []
        for batch in val_loader:
            tight, wide, labels, wide_scale = trainer.to_device(batch)
            logits = module((tight, wide))
            batch_meta = SpoofBatch(labels, wide_scale)
            meter.update({"loss": criterion(logits, batch_meta)}, n=1)
            scores.append(logits.softmax(dim=1)[:, LIVE].float().cpu().numpy())
            truth.append(labels.cpu().numpy())
        return {**meter.means(), **summary(np.concatenate(scores), np.concatenate(truth))}

    trainer = Trainer(
        model=model,
        optimizer=optimizer,
        scheduler=scheduler,
        train_loader=loader,
        cfg=cfg,
        run_dir=run,
        logger=logger,
        step_fn=step_fn,
        val_fn=val_fn,
        best_metric_key="eer",
    )
    logger.info(f"train={len(train_set)} val={len(val_set)}")
    trainer.fit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
