"""Branch-agnostic metric accumulators.

Task metrics (WIDER AP, HTER, TAR@FAR) belong to tasks/<branch>/eval.py; only
the plumbing lives here.
"""

from __future__ import annotations

import time
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass, field


@dataclass
class AverageMeter:
    """Running mean of one scalar."""

    total: float = 0.0
    count: int = 0

    def update(self, value: float, n: int = 1) -> None:
        self.total += float(value) * n
        self.count += n

    @property
    def mean(self) -> float:
        return self.total / self.count if self.count else 0.0

    def reset(self) -> None:
        self.total = 0.0
        self.count = 0


@dataclass
class MetricTracker:
    """A named bundle of AverageMeters."""

    meters: dict[str, AverageMeter] = field(default_factory=lambda: defaultdict(AverageMeter))

    def update(self, values: Mapping[str, float], n: int = 1) -> None:
        for key, value in values.items():
            self.meters[key].update(value, n)

    def means(self) -> dict[str, float]:
        return {key: meter.mean for key, meter in self.meters.items()}

    def reset(self) -> None:
        for meter in self.meters.values():
            meter.reset()

    def format(self, precision: int = 4) -> str:
        return " ".join(f"{k}={v:.{precision}f}" for k, v in sorted(self.means().items()))


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
