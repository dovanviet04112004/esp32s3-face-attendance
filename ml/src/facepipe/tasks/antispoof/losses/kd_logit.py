"""Score distillation: the student's two logits against the teacher's map score.

The teacher has no classifier, so there is no logit to copy. Its depth map is
collapsed to a mean and divided by the mean of a perfect live map, which puts a
live face near 1 and an attack at 0; a sigmoid then turns that into the
probability the student's softmax is compared against.

The division is not cosmetic. A mound averaged over the whole map is about 0.42,
so reading the raw mean as a probability puts a live face below one half and
inverts every gradient this term produces.
"""

from __future__ import annotations

import torch
from torch.nn import functional as fn

from facepipe.core.distiller import DistillLoss
from facepipe.core.registry import LOSSES

from ..teacher.cdcnpp import depth_to_score
from ..teacher.depth_gt import live_reference_mean
from .task_loss import SpoofBatch


@LOSSES.register("antispoof_kd_logit")
class ScoreDistillLoss(DistillLoss):
    """KL from the teacher's liveness probability to the student's."""

    def __init__(self, temperature: float = 2.0, scale: float = 4.0) -> None:
        super().__init__()
        self.temperature = temperature
        self.scale = scale

    def forward(
        self,
        student_out: torch.Tensor,
        teacher_out: torch.Tensor,
        batch: SpoofBatch = None,
        student_features: dict[str, torch.Tensor] | None = None,
        teacher_features: dict[str, torch.Tensor] | None = None,
    ) -> torch.Tensor:
        reference = live_reference_mean(batch.wide_scale.cpu().numpy())
        normalised = depth_to_score(teacher_out.detach()) / torch.as_tensor(
            reference, device=teacher_out.device, dtype=teacher_out.dtype
        )
        live = torch.sigmoid(self.scale * (normalised - 0.5))
        target = torch.stack((live, 1.0 - live), dim=1)
        student_log = fn.log_softmax(student_out / self.temperature, dim=1)
        # Temperature flattens both sides, and the usual T^2 puts the gradient
        # back on the scale the task loss is summed at.
        return fn.kl_div(student_log, target, reduction="batchmean") * self.temperature**2
