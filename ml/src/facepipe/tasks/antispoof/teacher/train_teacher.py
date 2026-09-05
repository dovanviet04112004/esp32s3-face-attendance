"""Train CDCN++ on CelebA-Spoof against pseudo depth maps.

The teacher never learns a class: it draws a mound over relief and a flat field
over a photograph (KEHOACH 1.1). Two terms against the same target - L1 sets the
level, the contrast term compares each pixel against its eight neighbours so the
shape has to match too.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.nn import functional as fn

from facepipe.core.config import Config, load_config
from facepipe.core.logger import RunLogger
from facepipe.core.metrics import MetricTracker
from facepipe.core.registry import TEACHERS
from facepipe.core.run_dir import create_run_dir
from facepipe.core.scheduler import build_optimizer, build_scheduler
from facepipe.core.seed import seed_everything
from facepipe.core.trainer import Trainer

from ..data import (
    CROP_SCALE_RANGE,
    PHOTOMETRIC_PROBABILITY,
    QUALITY_RANGE,
    RECOMPRESS_PROBABILITY,
    SpoofShardDataset,
    collate,
)
from ..eval import summary
from ..losses.contrastive_depth_loss import contrast_kernels
from ..losses.task_loss import LIVE
from .cdcnpp import CDCNpp, depth_to_score  # noqa: F401  registers "cdcnpp"
from .depth_gt import DEPTH_SIZE, LIVE, SIGMA_OF_FACE


class DepthSupervision(nn.Module):
    """L1 against the pseudo depth map, plus the same comparison on its contrasts.

    L1 is averaged inside and outside the face box separately and added, so the
    box carries half the term against 14% of the pixels and a flat answer stops
    being cheap (measurements 7).
    """

    def __init__(
        self,
        depth_size: int = DEPTH_SIZE,
        sigma: float = SIGMA_OF_FACE,
        contrast_weight: float = 10.0,
    ) -> None:
        super().__init__()
        self.depth_size = depth_size
        self.sigma = sigma
        self.contrast_weight = contrast_weight
        self.register_buffer("kernels", contrast_kernels())

    def contrast(self, depth: torch.Tensor) -> torch.Tensor:
        return fn.conv2d(depth.unsqueeze(1), self.kernels.to(depth.dtype), padding=1)

    def boxes(self, wide_scale: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """The mound and the face box for each sample, at that sample's crop scale."""
        axis = (torch.arange(self.depth_size, device=wide_scale.device) + 0.5)
        axis = axis / self.depth_size - 0.5
        grid_y, grid_x = torch.meshgrid(axis, axis, indexing="ij")
        scale = wide_scale.float().view(-1, 1, 1)
        face = (grid_x.abs() <= 0.5 / scale) & (grid_y.abs() <= 0.5 / scale)
        spread = self.sigma / scale
        mound = torch.exp(-(grid_x**2 + grid_y**2) / (2.0 * spread**2)) * face
        return mound, face

    def targets(self, labels: torch.Tensor, wide_scale: torch.Tensor) -> torch.Tensor:
        """The mound for a live face, zeros for an attack."""
        mound, _ = self.boxes(wide_scale)
        return torch.where(labels.view(-1, 1, 1) == LIVE, mound, torch.zeros_like(mound))

    def forward(
        self, depth: torch.Tensor, labels: torch.Tensor, wide_scale: torch.Tensor
    ) -> torch.Tensor:
        mound, face = self.boxes(wide_scale)
        target = torch.where(labels.view(-1, 1, 1) == LIVE, mound, torch.zeros_like(mound))
        target = target.to(depth.dtype)
        error = (depth - target).abs()
        inside = (error * face).sum(dim=(1, 2)) / face.sum(dim=(1, 2)).clamp(min=1)
        outside = (error * ~face).sum(dim=(1, 2)) / (~face).sum(dim=(1, 2)).clamp(min=1)
        level = (inside + outside).mean()
        shape = fn.mse_loss(self.contrast(depth), self.contrast(target))
        return level + self.contrast_weight * shape


def prefetch(cfg: Config) -> dict[str, int]:
    """DataLoader rejects prefetch_factor when it has no workers to prefetch on."""
    return {"prefetch_factor": cfg.data.prefetch_factor} if cfg.data.num_workers > 0 else {}


def crop_size(cfg: Config) -> int:
    """The size the loader feeds, taken from the one place it is declared."""
    height, width = cfg.model.input_hw
    if height != width:
        raise ValueError(f"model.input_hw must be square for this branch, got {height}x{width}")
    return int(height)


def build_loader(cfg: Config, split: str, train: bool) -> torch.utils.data.DataLoader:
    params = cfg.data.params
    dataset = SpoofShardDataset(
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
    )
    return torch.utils.data.DataLoader(
        dataset,
        batch_size=cfg.data.batch_size,
        num_workers=cfg.data.num_workers,
        pin_memory=cfg.data.pin_memory,
        drop_last=cfg.data.drop_last if train else False,
        collate_fn=collate,
        **prefetch(cfg),
    )


def liveness(depth: torch.Tensor, reference: torch.Tensor) -> torch.Tensor:
    """The map collapsed to a score in the range a threshold can be read on."""
    return depth_to_score(depth) / reference


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cfg", type=Path, required=True)
    parser.add_argument("--set", nargs="*", default=[], metavar="KEY=VALUE")
    args = parser.parse_args(argv)

    cfg = load_config(args.cfg, args.set)
    seed_everything(cfg.run.seed, deterministic=cfg.run.deterministic)
    run = create_run_dir(cfg)
    logger = RunLogger(run.path, tensorboard=cfg.log.tensorboard, level=cfg.log.level)

    model = TEACHERS.build({"name": cfg.model.name, "params": cfg.model.params})
    loader = build_loader(cfg, cfg.data.params.get("train_split", "train"), train=True)
    val_loader = build_loader(cfg, cfg.data.params.get("val_split", "valid"), train=False)

    supervision = DepthSupervision(**cfg.data.params.get("supervision", {}))
    optimizer = build_optimizer(model, cfg.optim)
    scheduler = build_scheduler(optimizer, cfg.sched, len(loader), cfg.train.epochs)

    def step_fn(batch: tuple[torch.Tensor, ...]) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
        tight, wide, labels, wide_scale = batch
        loss = supervision(trainer.model((tight, wide)), labels, wide_scale)
        return loss, {"depth": loss.detach()}

    @torch.no_grad()
    def val_fn(module: nn.Module, epoch: int) -> dict[str, float]:
        """Depth loss, and the error rates read off the map's own score.

        The teacher has no classifier, so liveness is the collapsed map, and the
        cut comes from where the two rates cross on this split. A constant would
        report 0.5 every epoch until the distribution happened to reach it.
        """
        module.eval()
        meter = MetricTracker()
        scores: list[np.ndarray] = []
        truth: list[np.ndarray] = []
        for batch in val_loader:
            tight, wide, labels, wide_scale = trainer.to_device(batch)
            depth = module((tight, wide))
            meter.update({"depth": supervision(depth, labels, wide_scale)}, n=1)
            reference = supervision.targets(torch.full_like(labels, LIVE), wide_scale)
            scores.append(liveness(depth, reference.mean(dim=(1, 2))).float().cpu().numpy())
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
    supervision = supervision.to(trainer.device)
    logger.info(f"teacher={cfg.model.name} train={len(loader.dataset)}")
    trainer.fit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
