"""Relational KD: copy the shape of the batch, not the position of each face.

Matching embeddings one by one asks a 1M-parameter student to land on the exact
points a 43M-parameter teacher chose, which it cannot do and which it does not
need to do. What identity comparison actually reads is relative: whether two
faces are closer to each other than to a third. This term supervises that
directly - distances between pairs and angles between triples - so the student is
free to place the whole batch elsewhere on the sphere as long as its geometry
matches (Park et al., Relational Knowledge Distillation).

Distances are divided by their own batch mean before comparison, on both sides.
Without that the term is dominated by the two models' different scales, and it
would be pulling on exactly the length that l2norm throws away.
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

    Huber rather than squared error because one mismatched pair in a batch of
    identities - the same person photographed twice, say - would otherwise
    dominate a term meant to describe the batch as a whole.

    The knee has to sit near the errors that actually occur or the robustness is
    not there at all. Measured between an untrained student and the teacher, the
    normalised distances differ by about 0.1, so the default beta of 1.0 that
    smooth_l1_loss ships with would keep every pair in the quadratic half and
    make this plain squared error.
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
