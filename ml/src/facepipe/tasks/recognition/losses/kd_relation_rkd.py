"""Relational KD: copy the shape of the batch, not the position of each face.

Distances between pairs and angles between triples, so the student may place the
batch anywhere on the sphere as long as the geometry matches (Park et al.).
Distances are divided by their own batch mean on both sides, or the term is
dominated by the two models' scales - the length l2norm throws away.
"""

from __future__ import annotations

import torch
from torch.nn import functional as fn

from facepipe.core.distiller import DistillLoss
from facepipe.core.registry import LOSSES


def pairwise_distances(embeddings: torch.Tensor, eps: float = 1e-12) -> torch.Tensor:
    """Euclidean distance between every pair, scaled by the mean off-diagonal one."""
    distances = torch.cdist(embeddings, embeddings, p=2).clamp_min(eps)
    count = distances.numel() - distances.shape[0]
    mean = distances.sum() / max(count, 1)
    return distances / mean.clamp_min(eps)


def pairwise_angles(embeddings: torch.Tensor) -> torch.Tensor:
    """Cosine of the angle at each vertex, over every triple in the batch."""
    differences = embeddings.unsqueeze(0) - embeddings.unsqueeze(1)
    directions = fn.normalize(differences, dim=2)
    return torch.bmm(directions, directions.transpose(1, 2))


@LOSSES.register("recognition_kd_relation_rkd")
class RelationDistillLoss(DistillLoss):
    """Huber loss on pairwise distances and on the angles between triples.

    Huber so one mismatched pair cannot dominate a term describing the whole
    batch. The knee must sit near the errors that occur: the shipped beta of 1.0
    would keep every pair quadratic and make this squared error (measurements 5).
    """

    def __init__(
        self, distance_weight: float = 1.0, angle_weight: float = 2.0, beta: float = 0.1
    ) -> None:
        super().__init__()
        self.distance_weight = distance_weight
        self.angle_weight = angle_weight
        self.beta = beta

    def forward(
        self,
        student_out: torch.Tensor,
        teacher_out: torch.Tensor,
        batch: object = None,
        student_features: dict[str, torch.Tensor] | None = None,
        teacher_features: dict[str, torch.Tensor] | None = None,
    ) -> torch.Tensor:
        student = student_out.float()
        teacher = teacher_out.detach().float()

        total = student.new_zeros(())
        if self.distance_weight:
            distance = fn.smooth_l1_loss(
                pairwise_distances(student), pairwise_distances(teacher), beta=self.beta
            )
            total = total + distance * self.distance_weight
        if self.angle_weight:
            angle = fn.smooth_l1_loss(
                pairwise_angles(student), pairwise_angles(teacher), beta=self.beta
            )
            total = total + angle * self.angle_weight
        return total
