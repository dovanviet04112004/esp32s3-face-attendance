"""Point the student's embedding the same way the teacher points its own.

Only the direction is copied: the device normalises before every comparison, so
matching length spends gradient on what nothing reads. The plan names this
cosine plus L2, but on unit vectors ||s - t||^2 = 2 - 2 cos(s, t) - the second
is the first times a constant, which the config weight already supplies.
"""

from __future__ import annotations

import torch
from torch.nn import functional as fn

from facepipe.core.distiller import DistillLoss
from facepipe.core.registry import LOSSES


@LOSSES.register("recognition_kd_embedding")
class EmbeddingDistillLoss(DistillLoss):
    """One minus the cosine similarity between student and teacher embeddings."""

    def forward(
        self,
        student_out: torch.Tensor,
        teacher_out: torch.Tensor,
        batch: object = None,
        student_features: dict[str, torch.Tensor] | None = None,
        teacher_features: dict[str, torch.Tensor] | None = None,
    ) -> torch.Tensor:
        student = fn.normalize(student_out.float(), dim=1)
        teacher = fn.normalize(teacher_out.detach().float(), dim=1)
        return (1.0 - (student * teacher).sum(dim=1)).mean()
