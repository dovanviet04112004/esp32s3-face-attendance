"""Depth distillation: the student copies the teacher's map, not just its answer.

The teacher regresses a 32x32 depth map; the student outputs two logits and has
no depth head of its own, so a projection reads the map out of the student's
fused embedding. That projection is trained here and thrown away at export: the
device only ever runs the classifier.

Copying the map rather than the label is the point of using CDCN++ as teacher at
all. The label says live or attack, which the student could already learn from
the data; the map says where on the face the evidence is, which it could not.
"""

from __future__ import annotations

import torch
from torch import nn

from facepipe.core.distiller import DistillLoss
from facepipe.core.registry import LOSSES

from ..teacher.depth_gt import DEPTH_SIZE


@LOSSES.register("antispoof_kd_depth_map")
class DepthMapDistillLoss(DistillLoss):
    """L1 between the teacher's depth map and one projected from the student.

    L1 rather than L2 because an attack's map is exactly zero everywhere: a
    squared error lets a few confident pixels dominate a map that should be
    uniformly flat, and flatness is the whole signal.
    """

    def __init__(self, embedding: int = 256, depth_size: int = DEPTH_SIZE) -> None:
        super().__init__()
        self.depth_size = depth_size
        self.project = nn.Sequential(
            nn.Linear(embedding, depth_size * depth_size),
            nn.ReLU(inplace=True),
        )

    def forward(
        self,
        student_out: torch.Tensor,
        teacher_out: torch.Tensor,
        batch: object = None,
        student_features: dict[str, torch.Tensor] | None = None,
        teacher_features: dict[str, torch.Tensor] | None = None,
    ) -> torch.Tensor:
        if not student_features:
            raise ValueError("depth distillation needs a student feature layer to project from")
        source = next(iter(student_features.values()))
        predicted = self.project(torch.flatten(source, 1))
        predicted = predicted.view(-1, self.depth_size, self.depth_size)
        return torch.nn.functional.l1_loss(predicted, teacher_out.detach())
