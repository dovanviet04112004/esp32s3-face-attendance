"""The shared training loop: AMP, EMA, grad clipping, checkpointing, resume.

Three branches drive this same loop. It never inspects what a batch contains;
the model, the loss and the collate function are the branch's business.
"""

from __future__ import annotations

import copy
import math
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, fields, is_dataclass, replace
from pathlib import Path
from typing import Any

import torch
from torch import nn
from torch.optim import Optimizer
from torch.optim.lr_scheduler import LRScheduler
from torch.utils.data import DataLoader

from facepipe.core.config import Config
from facepipe.core.logger import RunLogger
from facepipe.core.metrics import MetricTracker, Throughput, format_scalars
from facepipe.core.run_dir import RunDir
from facepipe.core.seed import capture_rng_state, restore_rng_state

CKPT_LAST = "last.pth"
CKPT_BEST = "best.pth"
CKPT_FORMAT_VER = 2
RESUMED_FROM_NAME = "resumed_from.txt"


def resolve_device(name: str = "auto") -> torch.device:
    """Turn the config string into a device, defaulting to CUDA when present."""
    if name != "auto":
        return torch.device(name)
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _compiled(model: nn.Module, mode: bool | str) -> nn.Module:
    """Wrap the model with torch.compile, or hand it back untouched.

    A small model spends most of a step in Python issuing one kernel per layer.
    Compiling trades warmup time for fewer and larger launches.
    """
    if not mode:
        return model
    return torch.compile(model, mode=mode if isinstance(mode, str) else "default")


class ModelEma:
    """Exponential moving average of the student weights.

    The shadow copy is kept on the same device and updated with no grad; it is
    what gets exported when ema_decay is on, since it is usually the better of
    the two.
    """

    def __init__(self, model: nn.Module, decay: float = 0.9998) -> None:
        if not 0.0 < decay < 1.0:
            raise ValueError(f"ema decay must be in (0, 1), got {decay}")
        self.decay = decay
        self.module = copy.deepcopy(model).eval()
        for param in self.module.parameters():
            param.requires_grad_(False)
        self._paired: tuple[nn.Module, list, list, list, list] | None = None

    def _pair(self, model: nn.Module) -> tuple[nn.Module, list, list, list, list]:
        """Line the shadow tensors up with the live ones, floats kept apart.

        Rebuilding per step costs two state_dict walks, and one tensor at a time
        costs two kernel launches each; together that measured a fifth of a step.
        """
        target = self.module.state_dict()
        floats: tuple[list, list] = ([], [])
        others: tuple[list, list] = ([], [])
        for key, value in model.state_dict().items():
            shadow = target[key]
            pair = floats if shadow.dtype.is_floating_point else others
            pair[0].append(shadow)
            pair[1].append(value)
        return model, floats[0], floats[1], others[0], others[1]

    @torch.no_grad()
    def update(self, model: nn.Module) -> None:
        if self._paired is None or self._paired[0] is not model:
            self._paired = self._pair(model)
        _, shadow_floats, live_floats, shadow_others, live_others = self._paired
        torch._foreach_mul_(shadow_floats, self.decay)
        torch._foreach_add_(shadow_floats, live_floats, alpha=1.0 - self.decay)
        for shadow, value in zip(shadow_others, live_others, strict=True):
            shadow.copy_(value)

    def state_dict(self) -> dict[str, Any]:
        return {"decay": self.decay, "module": self.module.state_dict()}

    def load_state_dict(self, state: Mapping[str, Any]) -> None:
        self.decay = float(state["decay"])
        self.module.load_state_dict(state["module"])


@dataclass
class TrainState:
    """Everything that has to survive an interrupted run."""

    epoch: int = 0
    global_step: int = 0
    best_metric: float = math.inf
    best_is_lower: bool = True
    history: list[dict[str, Any]] = field(default_factory=list)


class Trainer:
    """Drives one training run end to end.

    `step_fn` maps a batch to (loss, parts). Passing a Distiller covers both the
    plain and the distilled arms without a branch in this file.

    Checkpoints are written at epoch boundaries, so a resume replays from the
    last completed epoch and epoch count stays consistent with global_step.
    """

    def __init__(
        self,
        *,
        model: nn.Module,
        optimizer: Optimizer,
        train_loader: DataLoader,
        cfg: Config,
        run_dir: RunDir,
        logger: RunLogger,
        step_fn: Callable[[Any], tuple[torch.Tensor, dict[str, torch.Tensor]]],
        scheduler: LRScheduler | None = None,
        val_fn: Callable[[nn.Module, int], dict[str, float]] | None = None,
        best_metric_key: str = "loss",
        best_is_lower: bool = True,
        trained_elsewhere: Mapping[str, nn.Module] | None = None,
    ) -> None:
        self.cfg = cfg
        self.run_dir = run_dir
        self.logger = logger
        self.device = resolve_device(cfg.train.device)
        self.channels_last = cfg.train.channels_last
        # Parameters the optimizer owns but the exported model does not, such as
        # a classifier head living in the loss (KEHOACH 4.4).
        self.trained_elsewhere = dict(trained_elsewhere or {})
        self.module = model.to(self.device)
        if self.channels_last:
            self.module = self.module.to(memory_format=torch.channels_last)
        # A compiled wrapper renames state_dict keys with an _orig_mod prefix,
        # so weights are read and written through self.module, never self.model.
        self.model = _compiled(self.module, cfg.train.compile)
        self.optimizer = optimizer
        self.scheduler = scheduler
        self.train_loader = train_loader
        self.step_fn = step_fn
        self.val_fn = val_fn
        self.best_metric_key = best_metric_key

        self.amp_enabled = cfg.train.amp and self.device.type == "cuda"
        self.amp_dtype = getattr(torch, cfg.train.amp_dtype)
        self.scaler = torch.amp.GradScaler(self.device.type, enabled=self.amp_enabled)
        self.ema = ModelEma(self.module, cfg.train.ema_decay) if cfg.train.ema_decay > 0 else None
        # Divergence is recorded on device and read at logging cadence: testing
        # it per step would block on the accelerator every step.
        self.diverged = torch.zeros((), dtype=torch.bool, device=self.device)
        self.state = TrainState(best_is_lower=best_is_lower)
        self.state.best_metric = math.inf if best_is_lower else -math.inf

        self.resumed_from: str | None = None
        if cfg.train.resume is not None:
            self.load_checkpoint(Path(cfg.train.resume))

    @property
    def export_module(self) -> nn.Module:
        """The weights an export should take: EMA when enabled, live weights otherwise."""
        return self.ema.module if self.ema is not None else self.module

    def fit(self) -> TrainState:
        """Run from the current epoch to cfg.train.epochs."""
        total_epochs = self.cfg.train.epochs
        self.logger.info(
            f"training {self.run_dir.run_id} on {self.device} "
            f"from epoch {self.state.epoch} to {total_epochs}"
        )
        while self.state.epoch < total_epochs:
            epoch = self.state.epoch
            stats = self.train_one_epoch(epoch)
            self.state.epoch = epoch + 1

            if self.val_fn is not None and self._due(self.cfg.train.val_every_epochs):
                val_stats = self.val_fn(self.export_module, self.state.epoch)
                self.logger.log_scalars(self.state.global_step, prefix="val", **val_stats)
                # The metric a run is judged on belongs where someone watching a
                # long run will see it, not only in the event files.
                self.logger.info(f"epoch {epoch} val | {format_scalars(val_stats)}")
                stats = {**stats, **{f"val_{k}": v for k, v in val_stats.items()}}
                self._track_best(val_stats)

            self.state.history.append({"epoch": self.state.epoch, **stats})
            if self._due(self.cfg.train.ckpt_every_epochs):
                self.save_checkpoint(CKPT_LAST)
        self.save_checkpoint(CKPT_LAST)
        return self.state

    def _due(self, every: int) -> bool:
        return every > 0 and self.state.epoch % every == 0

    def train_one_epoch(self, epoch: int) -> dict[str, float]:
        """One pass over the loader, honouring gradient accumulation."""
        self.model.train()
        tracker = MetricTracker()
        throughput = Throughput()
        accum = self.cfg.train.accum_steps
        started = time.perf_counter()
        self.optimizer.zero_grad(set_to_none=True)

        for index, batch in enumerate(self.train_loader):
            batch = self.to_device(batch)
            with torch.amp.autocast(
                self.device.type, dtype=self.amp_dtype, enabled=self.amp_enabled
            ):
                loss, parts = self.step_fn(batch)
            self.diverged.logical_or_(~torch.isfinite(loss.detach()))

            self.scaler.scale(loss / accum).backward()
            tracker.update(parts, n=1)
            throughput.update(self._batch_size(batch))

            if (index + 1) % accum == 0:
                self._optimizer_step()
                self.state.global_step += 1
                if self.state.global_step % self.cfg.train.log_every_steps == 0:
                    self._log_step(tracker, throughput)

        if (len(self.train_loader) % accum) != 0:
            self._optimizer_step()
            self.state.global_step += 1

        self._check_diverged()
        stats = tracker.means()
        stats["epoch_seconds"] = time.perf_counter() - started
        self.logger.info(f"epoch {epoch} done | {tracker.format()}")
        return stats

    def _check_diverged(self) -> None:
        """Fail on a non-finite loss seen since the last check, and rearm.

        The gradient scaler skips a step whose gradients are not finite, so the
        steps between two checks are wasted rather than harmful.
        """
        if bool(self.diverged):
            raise FloatingPointError(f"non-finite loss by step {self.state.global_step}")
        self.diverged.zero_()

    def _optimizer_step(self) -> None:
        if self.cfg.train.grad_clip_norm > 0:
            self.scaler.unscale_(self.optimizer)
            torch.nn.utils.clip_grad_norm_(self.module.parameters(), self.cfg.train.grad_clip_norm)
        self.scaler.step(self.optimizer)
        self.scaler.update()
        self.optimizer.zero_grad(set_to_none=True)
        if self.scheduler is not None:
            self.scheduler.step()
        if self.ema is not None:
            self.ema.update(self.module)

    def _log_step(self, tracker: MetricTracker, throughput: Throughput) -> None:
        self._check_diverged()
        self.logger.log_scalars(
            self.state.global_step,
            prefix="train",
            lr=self.optimizer.param_groups[0]["lr"],
            samples_per_second=throughput.samples_per_second,
            **tracker.means(),
        )

    def _track_best(self, val_stats: Mapping[str, float]) -> None:
        """Save the best checkpoint, and refuse to run blind if it cannot be found.

        A key the validation never produces used to mean no best.pth for the whole
        run and no sign of it until the run was over and the file was missing.
        """
        value = val_stats.get(self.best_metric_key)
        if value is None:
            raise KeyError(
                f"best_metric_key {self.best_metric_key!r} is not among the validation "
                f"metrics {sorted(val_stats)}; best.pth would never be written"
            )
        better = (
            value < self.state.best_metric
            if self.state.best_is_lower
            else (value > self.state.best_metric)
        )
        if better:
            self.state.best_metric = float(value)
            self.save_checkpoint(CKPT_BEST)

    def to_device(self, batch: Any) -> Any:
        if isinstance(batch, torch.Tensor):
            moved = batch.to(self.device, non_blocking=True)
            # Bytes count as images: a branch normalising on the device would
            # otherwise reach the model contiguous, losing what this buys.
            if self.channels_last and moved.dim() == 4:
                moved = moved.contiguous(memory_format=torch.channels_last)
            return moved
        if isinstance(batch, Mapping):
            return {k: self.to_device(v) for k, v in batch.items()}
        if isinstance(batch, tuple | list):
            moved = [self.to_device(v) for v in batch]
            return type(batch)(moved) if isinstance(batch, tuple) else moved
        # Branches carry their targets in a dataclass. Left alone it would stay
        # on the host while the images move, and the loss would fail on device.
        if is_dataclass(batch) and not isinstance(batch, type):
            moved_fields = {f.name: self.to_device(getattr(batch, f.name)) for f in fields(batch)}
            return replace(batch, **moved_fields)
        return batch

    @staticmethod
    def _batch_size(batch: Any) -> int:
        if isinstance(batch, torch.Tensor):
            return batch.shape[0]
        if isinstance(batch, Mapping):
            return next((v.shape[0] for v in batch.values() if isinstance(v, torch.Tensor)), 1)
        if isinstance(batch, tuple | list):
            return next((v.shape[0] for v in batch if isinstance(v, torch.Tensor)), 1)
        return 1

    def save_checkpoint(self, filename: str = CKPT_LAST) -> Path:
        """Write a checkpoint that a resume can restore exactly.

        RNG state travels with it, so a resumed run draws the same augmentation
        stream a run that never stopped would have drawn.
        """
        payload: dict[str, Any] = {
            "format_ver": CKPT_FORMAT_VER,
            "epoch": self.state.epoch,
            "global_step": self.state.global_step,
            "best_metric": self.state.best_metric,
            "best_is_lower": self.state.best_is_lower,
            "history": self.state.history,
            "model": self.module.state_dict(),
            "optimizer": self.optimizer.state_dict(),
            "scaler": self.scaler.state_dict(),
            "rng": capture_rng_state(),
            "elsewhere": {n: m.state_dict() for n, m in self.trained_elsewhere.items()},
            "run_id": self.run_dir.run_id,
            "resumed_from": self.resumed_from,
        }
        if self.scheduler is not None:
            payload["scheduler"] = self.scheduler.state_dict()
        if self.ema is not None:
            payload["ema"] = self.ema.state_dict()

        target = self.run_dir.ckpt_dir / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".tmp")
        torch.save(payload, tmp)
        tmp.replace(target)
        return target

    def load_checkpoint(self, path: Path, weights_only_state: bool = False) -> None:
        """Restore from a checkpoint written by save_checkpoint."""
        payload = torch.load(path, map_location=self.device, weights_only=False)
        version = payload.get("format_ver")
        if version != CKPT_FORMAT_VER:
            raise ValueError(f"{path}: checkpoint format {version}, expected {CKPT_FORMAT_VER}")

        self.module.load_state_dict(payload["model"])
        if weights_only_state:
            return

        stored = payload.get("elsewhere", {})
        missing = set(self.trained_elsewhere) - set(stored)
        if missing:
            raise ValueError(f"{path}: checkpoint has no state for {sorted(missing)}")
        for name, module in self.trained_elsewhere.items():
            module.load_state_dict(stored[name])

        self.optimizer.load_state_dict(payload["optimizer"])
        self.scaler.load_state_dict(payload["scaler"])
        if self.scheduler is not None and "scheduler" in payload:
            self.scheduler.load_state_dict(payload["scheduler"])
        if self.ema is not None and "ema" in payload:
            self.ema.load_state_dict(payload["ema"])
        if "rng" in payload:
            restore_rng_state(payload["rng"])

        # A run_id carries a timestamp, so continuing lands in a new directory.
        # Recording the parent keeps the history from breaking across the two.
        self.resumed_from = payload.get("run_id")
        if self.resumed_from:
            (self.run_dir.path / RESUMED_FROM_NAME).write_text(
                f"{self.resumed_from}\n", encoding="utf-8"
            )

        self.state = TrainState(
            epoch=int(payload["epoch"]),
            global_step=int(payload["global_step"]),
            best_metric=float(payload["best_metric"]),
            best_is_lower=bool(payload["best_is_lower"]),
            history=list(payload.get("history", [])),
        )
        self.logger.info(
            f"resumed {path.name} at epoch {self.state.epoch}, step {self.state.global_step}"
        )
