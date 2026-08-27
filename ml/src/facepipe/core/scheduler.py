"""Optimizer and LR schedule construction from config.

Schedules step per optimizer step, not per epoch, so warmup stays meaningful
when the dataset or the batch size changes.
"""

from __future__ import annotations

import math
from collections.abc import Iterable

import torch
from torch.optim import Optimizer
from torch.optim.lr_scheduler import LambdaLR, LRScheduler

from facepipe.core.config import OptimSection, SchedSection
from facepipe.core.registry import OPTIMIZERS, SCHEDULERS


def _split_decay_groups(model: torch.nn.Module, weight_decay: float) -> list[dict[str, object]]:
    """Keep norm and bias parameters out of weight decay."""
    decay, no_decay = [], []
    for name, param in model.named_parameters():
        if not param.requires_grad:
            continue
        if param.ndim <= 1 or name.endswith(".bias"):
            no_decay.append(param)
        else:
            decay.append(param)
    return [
        {"params": decay, "weight_decay": weight_decay},
        {"params": no_decay, "weight_decay": 0.0},
    ]


def build_optimizer(model: torch.nn.Module, cfg: OptimSection) -> Optimizer:
    """Build the optimizer named in config, splitting decay groups first."""
    groups = _split_decay_groups(model, cfg.weight_decay)
    params = dict(cfg.params)
    if cfg.name in OPTIMIZERS:
        return OPTIMIZERS.get(cfg.name)(groups, lr=cfg.lr, **params)
    factory = {
        "sgd": lambda: torch.optim.SGD(
            groups, lr=cfg.lr, momentum=params.pop("momentum", 0.9), **params
        ),
        "adam": lambda: torch.optim.Adam(groups, lr=cfg.lr, **params),
        "adamw": lambda: torch.optim.AdamW(groups, lr=cfg.lr, **params),
    }.get(cfg.name)
    if factory is None:
        known = ", ".join(sorted({*factory_names(), *OPTIMIZERS.names()}))
        raise KeyError(f"optimizer {cfg.name!r} is unknown. Known: {known}")
    return factory()


def factory_names() -> Iterable[str]:
    return ("sgd", "adam", "adamw")


def build_scheduler(
    optimizer: Optimizer, cfg: SchedSection, steps_per_epoch: int, epochs: int
) -> LRScheduler:
    """Build a per-step LR schedule covering warmup plus the main shape."""
    total_steps = max(1, steps_per_epoch * epochs)
    warmup_steps = max(0, cfg.warmup_epochs * steps_per_epoch)
    base_lr = max(group["lr"] for group in optimizer.param_groups)
    floor = cfg.min_lr / base_lr if base_lr > 0 else 0.0

    if cfg.name in SCHEDULERS:
        return SCHEDULERS.get(cfg.name)(
            optimizer, total_steps=total_steps, warmup_steps=warmup_steps, **cfg.params
        )

    def cosine(step: int) -> float:
        progress = (step - warmup_steps) / max(1, total_steps - warmup_steps)
        return floor + (1.0 - floor) * 0.5 * (1.0 + math.cos(math.pi * min(1.0, progress)))

    def linear(step: int) -> float:
        progress = (step - warmup_steps) / max(1, total_steps - warmup_steps)
        return floor + (1.0 - floor) * max(0.0, 1.0 - progress)

    def constant(step: int) -> float:
        return 1.0

    def step_decay(step: int) -> float:
        gamma = float(cfg.params.get("gamma", 0.1))
        every = int(cfg.params.get("step_epochs", 30)) * steps_per_epoch
        return gamma ** ((step - warmup_steps) // max(1, every))

    shapes = {"cosine": cosine, "linear": linear, "constant": constant, "step": step_decay}
    if cfg.name not in shapes:
        known = ", ".join(sorted({*shapes, *SCHEDULERS.names()}))
        raise KeyError(f"scheduler {cfg.name!r} is unknown. Known: {known}")
    shape = shapes[cfg.name]

    def lr_lambda(step: int) -> float:
        if warmup_steps and step < warmup_steps:
            return (step + 1) / warmup_steps
        return max(0.0, shape(step))

    return LambdaLR(optimizer, lr_lambda)
