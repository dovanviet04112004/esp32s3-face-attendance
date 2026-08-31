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

from ..data import SpoofShardDataset, collate
from ..losses.contrastive_depth_loss import contrast_kernels
from ..losses.task_loss import LIVE
from .cdcnpp import CDCNpp, depth_to_score  # noqa: F401  registers "cdcnpp"
from .depth_gt import DEPTH_SIZE, gaussian_map, live_reference_mean

LIVE_THRESHOLD = 0.5


class DepthSupervision(nn.Module):
    """L1 against the pseudo depth map, plus the same comparison on its contrasts.

    The two terms are not naturally on one scale. The mound falls off over
    sixteen pixels, so its neighbour differences are around 0.06 and squaring
    them leaves the contrast term an order of magnitude under the L1: measured
    on a live target, 0.039 against 0.0048 for a noisy prediction and 0.210
    against 0.0057 for the uniform blob the L1 alone would settle for. The
    default weight brings the two within a factor of two at the first of those.
    """

    def __init__(
        self, depth_size: int = DEPTH_SIZE, sigma: float = 0.28, contrast_weight: float = 10.0
    ) -> None:
        super().__init__()
        self.contrast_weight = contrast_weight
        self.register_buffer("mound", torch.from_numpy(gaussian_map(depth_size, sigma)))
        self.register_buffer("kernels", contrast_kernels())

    def contrast(self, depth: torch.Tensor) -> torch.Tensor:
        return fn.conv2d(depth.unsqueeze(1), self.kernels.to(depth.dtype), padding=1)

    def targets(self, labels: torch.Tensor) -> torch.Tensor:
        """The mound for a live face, zeros for an attack."""
        mound = self.mound.to(labels.device)
        return torch.where(labels.view(-1, 1, 1) == LIVE, mound, torch.zeros_like(mound))

    def forward(self, depth: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
        target = self.targets(labels).to(depth.dtype)
        level = fn.l1_loss(depth, target)
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
    dataset = SpoofShardDataset(
        root=Path(cfg.data.params["shards"]) / split,
        size=crop_size(cfg),
        train=train,
        seed=cfg.run.seed,
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
        """Depth loss and the two error rates ACER averages.

        The teacher has no classifier, so the class here comes from thresholding
        the map's own score, the same way export and distillation read it.
        """
        module.eval()
        meter = MetricTracker()
        attacks = live = attacks_passed = live_rejected = 0
        for batch in val_loader:
            tight, wide, labels = trainer.to_device(batch)
            depth = module((tight, wide))
            meter.update({"depth": supervision(depth, labels)}, n=1)
            predicted_live = liveness(depth, reference) >= LIVE_THRESHOLD
            attacks += int((labels != LIVE).sum())
            live += int((labels == LIVE).sum())
            attacks_passed += int(((labels != LIVE) & predicted_live).sum())
            live_rejected += int(((labels == LIVE) & ~predicted_live).sum())
        apcer = attacks_passed / attacks if attacks else 0.0
        bpcer = live_rejected / live if live else 0.0
        return {**meter.means(), "apcer": apcer, "bpcer": bpcer, "acer": (apcer + bpcer) / 2}

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
        best_metric_key="acer",
    )
    supervision = supervision.to(trainer.device)
    logger.info(f"teacher={cfg.model.name} train={len(loader.dataset)}")
    trainer.fit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
