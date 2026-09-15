"""The one entry point that trains the anti-spoof branch.

Validation reports APCER and BPCER separately, not one accuracy: an attack that
gets in and a real face turned away cost different things on a door.
"""

from __future__ import annotations

import argparse
from functools import partial
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
    BACKLIGHT_RANGE,
    CROP_SCALE_PROBABILITY,
    CROP_SCALE_RANGE,
    EXPOSURE_CONTRAST_RANGE,
    OCCLUSION_PROBABILITY,
    OCCLUSION_SIDE_RANGE,
    PHOTOMETRIC_PROBABILITY,
    QUALITY_RANGE,
    RECOMPRESS_PROBABILITY,
    ROLL_PROBABILITY,
    ROLL_RANGE,
    TRANSLATE_PROBABILITY,
    TRANSLATE_RANGE,
    WHITE_BALANCE_RANGE,
    SpoofShardDataset,
    collate,
    surface_of,
    to_tensor,
)
from .eval import keeps_wide, summary
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


DEVICE_LIVE_MIN = 0.75
DEVICE_BLOCKED_BUDGET = 3          # real faces this camera may turn away


def ranking_auc(live: np.ndarray, attack: np.ndarray) -> float:
    """Probability a live frame outranks an attack, counted on ranks rather than bins."""
    ranks = np.concatenate([live, attack]).argsort().argsort() + 1
    return float(
        (ranks[: live.size].sum() - live.size * (live.size + 1) / 2) / (live.size * attack.size)
    )


def device_frames(cfg: Config) -> tuple[torch.Tensor, np.ndarray] | None:
    """The held-out camera frames, already cropped, or None when none are named."""
    named = (cfg.data.params or {}).get("device_eval")
    if not named:
        return None
    blob = np.load(Path(named))
    chroma = bool(cfg.model.params.get("chroma", False))
    return torch.stack([to_tensor(crop, chroma) for crop in blob["crops"]]), blob["labels"]


def surface_ceiling(cfg: Config) -> float | None:
    """What a bare sharpness threshold already scores on the held-out frames.

    A model below this earned nothing the firmware could not do with one compare,
    and this branch has published a device number that sat under it (KEHOACH 4.2).
    """
    named = (cfg.data.params or {}).get("device_eval")
    if not named:
        return None
    blob = np.load(Path(named))
    sharp = np.array([surface_of(crop) for crop in blob["crops"]])
    live, attack = sharp[blob["labels"] == 0], sharp[blob["labels"] == 1]
    return ranking_auc(live, attack) if live.size and attack.size else None


def on_device(module: nn.Module, held, device) -> dict[str, float]:
    """Scores on the camera's own frames, reported and never selected on.

    Making this the key the trainer picks best.pth by would fit a checkpoint to
    the only honest measurement this branch has (KEHOACH 4.2).
    """
    if held is None:
        return {}
    crops, labels = held
    was_training = module.training
    module.eval()
    with torch.no_grad():
        logits = module((crops.to(device), torch.empty(0)))
    module.train(was_training)
    scores = logits.softmax(dim=1)[:, LIVE].float().cpu().numpy()
    live, attack = scores[labels == 0], scores[labels == 1]
    if not live.size or not attack.size:
        return {}
    acer = min(((live < cut).mean() + (attack >= cut).mean()) / 2 for cut in np.sort(scores))
    # Held at one cost in real faces, since dev_caught moves with the distribution.
    budget = np.sort(live)[DEVICE_BLOCKED_BUDGET] if live.size > DEVICE_BLOCKED_BUDGET else 0.0
    return {
        "dev_auc": ranking_auc(live, attack),
        "dev_acer": float(acer),
        "dev_blocked": float((live < DEVICE_LIVE_MIN).sum()),
        "dev_caught": float((attack < DEVICE_LIVE_MIN).sum()),
        "dev_caught_on_budget": float((attack < budget).sum()),
        # Negative means the tails overlap, and a positive one under a quantisation
        # step is a separation INT8 cannot carry to the board (KEHOACH 4.2).
        "dev_gap": float(np.percentile(live, 5) - np.percentile(attack, 95)),
    }


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
        exposure_contrast_range=tuple(
            params.get("exposure_contrast_range", EXPOSURE_CONTRAST_RANGE)
        ),
        white_balance_range=tuple(params.get("white_balance_range", WHITE_BALANCE_RANGE)),
        backlight_range=tuple(params.get("backlight_range", BACKLIGHT_RANGE)),
        crop_scale_range=tuple(params.get("crop_scale_range", CROP_SCALE_RANGE)),
        crop_scale_probability=float(params.get("crop_scale_probability", CROP_SCALE_PROBABILITY)),
        occlusion_probability=float(params.get("occlusion_probability", OCCLUSION_PROBABILITY)),
        occlusion_side_range=tuple(params.get("occlusion_side_range", OCCLUSION_SIDE_RANGE)),
        roll_probability=float(params.get("roll_probability", ROLL_PROBABILITY)),
        roll_range=tuple(params.get("roll_range", ROLL_RANGE)),
        translate_probability=float(params.get("translate_probability", TRANSLATE_PROBABILITY)),
        translate_range=float(params.get("translate_range", TRANSLATE_RANGE)),
        surface_band=tuple(params.get("surface_band", (0.0, 0.0))),
        bright_band=tuple(params.get("bright_band", (0.0, 0.0))),
        chroma_band=tuple(params.get("chroma_band", (0.0, 0.0))),
        motion_blur_probability=params.get("motion_blur_probability"),
        keep_wide=keeps_wide(cfg),
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
        collate_fn=partial(collate, chroma=bool(cfg.model.params.get("chroma", False))),
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

    train_set = build_dataset(cfg, cfg.data.params.get("train_split", "train"), train=True)
    params = dict(cfg.model.params)
    # Counted off the split rather than written down twice, or a pool change
    # would silently leave the head sized for the old one (KEHOACH 3).
    if cfg.loss.get("domain_weight", 0.0) > 0.0:
        params["domains"] = len(train_set.domains)
    model = MODELS.build({"name": cfg.model.name, "params": params})
    loader = build_loader(cfg, train_set, train=True)
    val_set = build_dataset(cfg, cfg.data.params.get("val_split", "valid"), train=False)
    val_loader = build_loader(cfg, val_set, train=False)

    criterion = LOSSES.get(TASK_LOSS)(**cfg.loss)

    # Order matters: a resume casts optimizer momentum onto whichever device it
    # finds the parameters on, and they start on the host.
    device = resolve_device(cfg.train.device)
    model.to(device)
    criterion.to(device)

    optimizer = build_optimizer(model, cfg.optim)
    scheduler = build_scheduler(optimizer, cfg.sched, len(loader), cfg.train.epochs)

    def step_fn(batch: tuple[torch.Tensor, ...]) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
        tight, wide, labels, wide_scale, domains = batch
        train_set.epoch = trainer.state.epoch
        # trainer.model, not the module above: a compiled run must reach the
        # wrapper the trainer built, or the graph is traced twice.
        loss = criterion(trainer.model((tight, wide)), SpoofBatch(labels, wide_scale, domains))
        return loss, {"task": loss.detach(), "total": loss.detach()}

    held = device_frames(cfg)

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
            tight, wide, labels, wide_scale, domains = trainer.to_device(batch)
            logits = module((tight, wide))
            batch_meta = SpoofBatch(labels, wide_scale, domains)
            meter.update({"loss": criterion(logits, batch_meta)}, n=1)
            scores.append(logits.softmax(dim=1)[:, LIVE].float().cpu().numpy())
            truth.append(labels.cpu().numpy())
        stats = {**meter.means(), **summary(np.concatenate(scores), np.concatenate(truth))}
        return {**stats, **on_device(module, held, trainer.device)}

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
    ceiling = surface_ceiling(cfg)
    logger.info(f"train={len(train_set)} val={len(val_set)} surface_ceiling={ceiling}")
    trainer.fit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
