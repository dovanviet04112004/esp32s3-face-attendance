"""Contrastive depth loss: match the map's local contrast, not its level.

An L1 on the map alone is satisfied by a smooth blob of the right brightness.
This compares each pixel against its eight neighbours in both maps, scoring the
shape of the relief - which is what separates a live face from a curved print,
whose depth is also non-flat but whose gradients do not follow a face.
"""

from __future__ import annotations

import torch
from torch import nn
from torch.nn import functional as fn

from facepipe.core.distiller import DistillLoss
from facepipe.core.registry import LOSSES

# Each kernel subtracts the centre from one of the eight neighbours, so a filter
# bank of all eight reads the local gradient in every direction at once.
NEIGHBOURS = (
    (0, 0),
    (0, 1),
    (0, 2),
    (1, 0),
    (1, 2),
    (2, 0),
    (2, 1),
    (2, 2),
)


def contrast_kernels() -> torch.Tensor:
    """One 3x3 kernel per neighbour: +1 there, -1 at the centre."""
    kernels = torch.zeros(len(NEIGHBOURS), 1, 3, 3, dtype=torch.float32)
    for index, (row, column) in enumerate(NEIGHBOURS):
        kernels[index, 0, row, column] = 1.0
        kernels[index, 0, 1, 1] = -1.0
    return kernels


@LOSSES.register("antispoof_contrastive_depth")
class ContrastiveDepthLoss(DistillLoss):
    """Mean squared error between the two maps' directional contrasts."""

    def __init__(self, embedding: int = 256, depth_size: int = 32) -> None:
        super().__init__()
        self.depth_size = depth_size
        self.register_buffer("kernels", contrast_kernels())
        self.project = nn.Sequential(
            nn.Linear(embedding, depth_size * depth_size),
            nn.ReLU(inplace=True),
        )

    def contrast(self, depth: torch.Tensor) -> torch.Tensor:
        kernels = self.kernels.to(depth.device, depth.dtype)
        return fn.conv2d(depth.unsqueeze(1), kernels, padding=1)

    def forward(
        self,
        student_out: torch.Tensor,
        teacher_out: torch.Tensor,
        batch: object = None,
        student_features: dict[str, torch.Tensor] | None = None,
        teacher_features: dict[str, torch.Tensor] | None = None,
    ) -> torch.Tensor:
        if not student_features:
            raise ValueError("contrastive depth needs a student feature layer to project from")
        source = next(iter(student_features.values()))
        predicted = self.project(torch.flatten(source, 1))
        predicted = predicted.view(-1, self.depth_size, self.depth_size)
        return fn.mse_loss(self.contrast(predicted), self.contrast(teacher_out.detach()))
