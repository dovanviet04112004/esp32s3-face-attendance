"""ArcFace: the task loss, an angular margin on the real identity labels.

The margin is added to the angle rather than the cosine, so the penalty is the
same near a class centre as far from it and the boundary stays a cone. The
classifier weight is trained here and thrown away at export: the device runs the
backbone and compares embeddings, never these 84 thousand columns.
"""

from __future__ import annotations

import math
from typing import Any

import torch
from torch import nn
from torch.nn import functional as fn

from facepipe.core.registry import LOSSES


@LOSSES.register("recognition_arcface")
class ArcFaceLoss(nn.Module):
    """Cross entropy over cosines, with an additive angular margin on the target.

    Takes the branch's target record and reads its labels field, so a batch can
    carry cached teacher embeddings alongside without this loss knowing.
    """

    def __init__(
        self,
        num_classes: int,
        embedding: int = 512,
        scale: float = 64.0,
        margin: float = 0.5,
    ) -> None:
        super().__init__()
        if num_classes < 2:
            raise ValueError(f"arcface needs at least two classes, got {num_classes}")
        self.weight = nn.Parameter(torch.empty(num_classes, embedding))
        nn.init.normal_(self.weight, std=0.01)
        self.scale = scale
        self.margin = margin
        self.cos_margin = math.cos(margin)
        self.sin_margin = math.sin(margin)
        # Past this angle cos(theta + m) turns back upwards, so the margin would
        # start rewarding a worse prediction; beyond it a linear penalty is used.
        self.turning_point = math.cos(math.pi - margin)
        self.turning_penalty = math.sin(math.pi - margin) * margin

    def cosines(self, embeddings: torch.Tensor) -> torch.Tensor:
        """Cosine of every embedding against every class centre."""
        return fn.normalize(embeddings.float()) @ fn.normalize(self.weight).t()

    def margin_applied(self, cosine: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
        """Replace each target cosine with cos(theta + margin)."""
        index = labels.view(-1, 1)
        target = cosine.gather(1, index).squeeze(1)
        # cos(theta + m) from the angle-addition formula: acos on a value that
        # rounds to +-1 loses most of its precision, and this never needs it.
        sine = torch.sqrt((1.0 - target * target).clamp_min(0.0))
        shifted = target * self.cos_margin - sine * self.sin_margin
        penalised = torch.where(target > self.turning_point, shifted, target - self.turning_penalty)
        return cosine.scatter(1, index, penalised.view(-1, 1))

    def forward(self, embeddings: torch.Tensor, batch: Any) -> torch.Tensor:
        labels = batch.labels
        cosine = self.cosines(embeddings)
        return fn.cross_entropy(self.margin_applied(cosine, labels) * self.scale, labels)
