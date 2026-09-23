"""The one entry point that trains the recognition branch.

Validation is verification on LFW, CFP-FP and AgeDB-30, never the training loss:
the loss of an ArcFace run rises through the tail of the schedule while the
embeddings keep improving, so it says nothing about where the run stands.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import torch
from torch import nn
from torch.utils.data import DataLoader

from facepipe.core.config import Config, load_config
from facepipe.core.logger import RunLogger
from facepipe.core.registry import LOSSES, MODELS
from facepipe.core.run_dir import create_run_dir
from facepipe.core.scheduler import build_optimizer, build_scheduler
from facepipe.core.seed import seed_everything
from facepipe.core.trainer import Trainer, resolve_device

from .data import Ms1mShardDataset, RecogTargets, collate, normalize_batch, read_identities
from .eval import evaluate_all
from .losses import arcface  # noqa: F401  registers "recognition_arcface"
from .model import mobilefacenet  # noqa: F401  registers "mobilefacenet"

TASK_LOSS = "recognition_arcface"
BEST_METRIC = "cfp_fp_tar@far0.001"


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
    return Ms1mShardDataset(
        root=Path(params["shards"]),
        identities=read_identities(Path(cfg.data.split_files[split_index])),
        size=crop_size(cfg),
        train=train,
        seed=cfg.run.seed,
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
    loader = build_loader(cfg, train_set, train=True)
    benchmarks = Path(cfg.data.params["benchmarks"])

    task_loss = LOSSES.get(TASK_LOSS)(
        num_classes=train_set.num_classes,
        embedding=int(cfg.model.params.get("embedding", 512)),
        **cfg.data.params.get("arcface", {}),
    )

    # The ArcFace centres are trainable and live in the loss, not the model, so
    # the optimizer is built over both and the centres are checkpointed too.
    trained = nn.ModuleDict({"model": model, "loss": task_loss})
    # Order matters: a resume casts optimizer momentum onto whichever device it
    # finds the parameters on, and they start on the host.
    trained.to(resolve_device(cfg.train.device))

    optimizer = build_optimizer(trained, cfg.optim)
    scheduler = build_scheduler(optimizer, cfg.sched, len(loader), cfg.train.epochs)

    def step_fn(batch: tuple[torch.Tensor, RecogTargets]) -> tuple[torch.Tensor, dict]:
        images, targets = batch
        train_set.epoch = trainer.state.epoch
        # trainer.model, not the module above: a compiled run must reach the
        # wrapper the trainer built, or the graph is traced twice.
        loss = task_loss(trainer.model(normalize_batch(images)), targets)
        return loss, {"task": loss.detach(), "total": loss.detach()}

    def val_fn(module: nn.Module, epoch: int) -> dict[str, float]:
        """Verification accuracy on each benchmark, flattened for the logger."""
        scores = evaluate_all(
            module, benchmarks, trainer.device, batch_size=cfg.data.batch_size, size=crop_size(cfg)
        )
        return {f"{name}_{k}": v for name, values in scores.items() for k, v in values.items()}

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
        trained_elsewhere={"loss": task_loss},
        best_metric_key=BEST_METRIC,
        best_is_lower=False,
    )
    logger.info(f"identities={train_set.num_classes} records={len(train_set)}")
    trainer.fit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
