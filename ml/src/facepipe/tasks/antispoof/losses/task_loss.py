"""Live against spoof on the real labels, with the class ratio compensated.

CelebA-Spoof carries 348,602 attacks to 177,262 live faces, about two to one
(docs/DU_LIEU.md), so answering "spoof" to everything already scores 66 percent.
The weight is the inverse of that ratio and does one thing: keep the smaller
class from being learned as noise. Rebalancing here rather than by dropping
attacks keeps every sample the split already committed to (KEHOACH section 1.3).

Which error costs more on a door is a different question with a different lever.
An attack accepted is worse than a live face turned away, and that asymmetry is
set by the decision threshold at inference, where it can be retuned without
retraining. Folding it into this weight would fix it into the weights instead.
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

    def __init__(self, live_weight: float = 1.97, label_smoothing: float = 0.0) -> None:
        super().__init__()
        weight = torch.tensor([live_weight, 1.0], dtype=torch.float32)
        self.register_buffer("class_weight", weight)
        self.label_smoothing = label_smoothing

    def forward(self, logits: torch.Tensor, batch: SpoofBatch) -> torch.Tensor:
        # The trainer moves the model, not the loss the distiller holds, so this
        # buffer follows the logits rather than assuming anyone moved it.
        return nn.functional.cross_entropy(
            logits,
            batch.labels,
            weight=self.class_weight.to(logits.device, logits.dtype),
            label_smoothing=self.label_smoothing,
        )
