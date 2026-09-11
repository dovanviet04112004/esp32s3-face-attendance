"""Live against spoof on the real labels, with the class ratio compensated.

The weight inverts the whole pool's attack ratio, counted on the shards rather
than the listings (measurements/antispoof 26), and keeps the smaller class from
being learned as noise. Which error costs more on a door is a separate question,
set by the decision threshold at inference, retunable without retraining.
"""

from __future__ import annotations

from typing import NamedTuple

import torch
from torch import nn

from facepipe.core.registry import LOSSES

LIVE, SPOOF = 0, 1


class SpoofBatch(NamedTuple):
    """What a loss is told about the samples behind one batch of logits."""

    labels: torch.Tensor
    wide_scale: torch.Tensor


@LOSSES.register("antispoof_task")
class SpoofTaskLoss(nn.Module):
    """Cross entropy over the two classes, live weighted by the class ratio."""

    # 339 697 attacks over 161 329 live (measurements/antispoof 26).
    def __init__(self, live_weight: float = 2.11, label_smoothing: float = 0.0) -> None:
        super().__init__()
        weight = torch.tensor([live_weight, 1.0], dtype=torch.float32)
        self.register_buffer("class_weight", weight)
        self.label_smoothing = label_smoothing

    def forward(self, logits: torch.Tensor, batch: SpoofBatch) -> torch.Tensor:
        # The trainer moves the model, not the loss beside it, so this
        # buffer follows the logits rather than assuming anyone moved it.
        return nn.functional.cross_entropy(
            logits,
            batch.labels,
            weight=self.class_weight.to(logits.device, logits.dtype),
            label_smoothing=self.label_smoothing,
        )
