"""Point the student's embedding the same way the teacher points its own.

The teacher is a ResNet50 trained on WebFace600K, ten times the student's depth
on a dataset it will never see; copying where it puts a face on the unit sphere
is the whole of what the student can inherit from it.

Only the direction is copied. Length carries no identity - the device normalises
before every comparison (postproc/l2norm.py) - so a term that also matched length
would spend gradient on a quantity nothing downstream reads.

The plan names this term cosine plus L2. On unit vectors those are one term, not
two: ||s - t||^2 = 2 - 2 cos(s, t), so adding the second only multiplies the
gradient of the first by a constant, which the weight in the config already does.
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
