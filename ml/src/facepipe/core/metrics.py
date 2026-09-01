"""Branch-agnostic metric accumulators.

Task metrics (WIDER AP, HTER, TAR@FAR) belong to tasks/<branch>/eval.py; only
the plumbing lives here.
"""

from __future__ import annotations

import time
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass, field

import torch


@dataclass
class AverageMeter:
    """Running mean of one scalar, summed in whatever type the value arrives as.

    A value read off the accelerator stays there until mean is taken. Casting it
    on the step that produced it would block until the device caught up, once per
    loss term per step.
    """

    total: float | torch.Tensor = 0.0
    count: int = 0

    def update(self, value: float | torch.Tensor, n: int = 1) -> None:
        self.total = self.total + value * n
        self.count += n

    @property
    def mean(self) -> float:
        return float(self.total) / self.count if self.count else 0.0

    def reset(self) -> None:
        self.total = 0.0
        self.count = 0


def format_scalars(values: Mapping[str, float], precision: int = 4) -> str:
    """One line of name=value pairs, sorted so two epochs line up column by column."""
    return " ".join(f"{key}={value:.{precision}f}" for key, value in sorted(values.items()))


@dataclass
class MetricTracker:
    """A named bundle of AverageMeters."""

    meters: dict[str, AverageMeter] = field(default_factory=lambda: defaultdict(AverageMeter))

    def update(self, values: Mapping[str, float | torch.Tensor], n: int = 1) -> None:
        for key, value in values.items():
            self.meters[key].update(value, n)

    def means(self) -> dict[str, float]:
        return {key: meter.mean for key, meter in self.meters.items()}

    def reset(self) -> None:
        for meter in self.meters.values():
            meter.reset()

    def format(self, precision: int = 4) -> str:
        return format_scalars(self.means(), precision)


class Throughput:
    """Samples per second over a window, for spotting a dataloader bottleneck."""

    def __init__(self) -> None:
        self._start = time.perf_counter()
        self._samples = 0

    def update(self, samples: int) -> None:
        self._samples += samples

    @property
    def samples_per_second(self) -> float:
        elapsed = time.perf_counter() - self._start
        return self._samples / elapsed if elapsed > 0 else 0.0

    def reset(self) -> None:
        self._start = time.perf_counter()
        self._samples = 0
