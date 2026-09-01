"""Train CDCN++ on CelebA-Spoof against pseudo depth maps.

The teacher never learns a class. It learns to draw a mound where there is a
face with relief and a flat field where there is a photograph, and the class it
implies is read off that map afterwards. Supervising geometry instead of a label
is the whole reason this teacher is worth distilling from: the label is already
in the data the student sees, the map is not (KEHOACH section 1.1).

Two terms, both against the same target. L1 puts the map at the right level, and
the contrast term compares each pixel against its eight neighbours so the shape
of the relief has to match too - without it the L1 is satisfied by a smooth blob
of roughly the right brightness, which is exactly what a curved print produces.

Usage:
    python -m facepipe.tasks.antispoof.teacher.train_teacher \\
        --cfg configs/antispoof/teacher_cdcnpp.yaml
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
from .depth_gt import DEPTH_SIZE, SIGMA_OF_FACE, face_mask, gaussian_map, live_reference_mean


class DepthSupervision(nn.Module):
    """L1 against the pseudo depth map, plus the same comparison on its contrasts.

    L1 is averaged over the face box and over the room separately and added: the
    box holds 14% of the pixels but carries half the term, and one mean over the
    map would price a flat answer at 0.0585 rather than 0.4160. On a live target
    the level reads 0.063 against a contrast of 0.0025 for a noisy prediction,
    which is the gap the default weight closes.
    """

    def __init__(
        self,
        depth_size: int = DEPTH_SIZE,
        sigma: float = SIGMA_OF_FACE,
        contrast_weight: float = 10.0,
    ) -> None:
        super().__init__()
        self.contrast_weight = contrast_weight
        self.register_buffer("mound", torch.from_numpy(gaussian_map(depth_size, sigma)))
        self.register_buffer("face", torch.from_numpy(face_mask(depth_size)))
        self.register_buffer("kernels", contrast_kernels())

    def contrast(self, depth: torch.Tensor) -> torch.Tensor:
        return fn.conv2d(depth.unsqueeze(1), self.kernels.to(depth.dtype), padding=1)

    def targets(self, labels: torch.Tensor) -> torch.Tensor:
        """The mound for a live face, zeros for an attack."""
        mound = self.mound.to(labels.device)
        return torch.where(labels.view(-1, 1, 1) == LIVE, mound, torch.zeros_like(mound))

    def forward(self, depth: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
        target = self.targets(labels).to(depth.dtype)
        face = self.face.to(depth.device)
        error = (depth - target).abs()
        level = error[:, face].mean() + error[:, ~face].mean()
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


def liveness(depth: torch.Tensor, reference: float) -> torch.Tensor:
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
    reference = live_reference_mean()
    optimizer = build_optimizer(model, cfg.optim)
    scheduler = build_scheduler(optimizer, cfg.sched, len(loader), cfg.train.epochs)

    def step_fn(batch: tuple[torch.Tensor, ...]) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
        tight, wide, labels = batch
        loss = supervision(trainer.model((tight, wide)), labels)
        return loss, {"depth": loss.detach()}

    @torch.no_grad()
    def val_fn(module: nn.Module, epoch: int) -> dict[str, float]:
        """Depth loss, and the error rates read off the map's own score.

        The teacher has no classifier, so liveness is the collapsed map. Where to
        cut it comes from where the two error rates cross on this split, not from
        a constant: an untrained map scores below any fixed threshold, so a fixed
        one reports 0.5 for every epoch until the distribution happens to cross it.
        """
        module.eval()
        meter = MetricTracker()
        scores: list[np.ndarray] = []
        truth: list[np.ndarray] = []
        for batch in val_loader:
            tight, wide, labels = trainer.to_device(batch)
            depth = module((tight, wide))
            meter.update({"depth": supervision(depth, labels)}, n=1)
            scores.append(liveness(depth, reference).float().cpu().numpy())
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
