"""Classification distillation: KL between teacher and student face scores.

The head carries one class and a sigmoid, so the divergence is Bernoulli, not
the categorical softmax the usual formulation assumes. Both terms are kept, or
the student agrees with the teacher on faces and says anything elsewhere.
Teacher output arrives already resampled onto the student's priors.
"""

from __future__ import annotations

import torch
from torch.nn.functional import logsigmoid

from facepipe.core.distiller import DistillLoss
from facepipe.core.registry import LOSSES

from ..postproc.decode import flatten_levels
from ..student.head import HeadOutput


def binary_kl(student_logits: torch.Tensor, teacher_logits: torch.Tensor) -> torch.Tensor:
    """KL(teacher || student) for independent Bernoulli variables, elementwise."""
    log_p = logsigmoid(teacher_logits)
    log_1_p = logsigmoid(-teacher_logits)
    log_q = logsigmoid(student_logits)
    log_1_q = logsigmoid(-student_logits)
    p = log_p.exp()
    return p * (log_p - log_q) + (1 - p) * (log_1_p - log_1_q)


@LOSSES.register("detection_kd_logit")
class LogitDistillLoss(DistillLoss):
    """Temperature-scaled KL on the classification branch.

    The T^2 factor restores the gradient magnitude that dividing the logits by T
    removes, so the temperature can be tuned without retuning the loss weight.
    """

    def __init__(self, temperature: float = 3.0) -> None:
        super().__init__()
        if temperature <= 0:
            raise ValueError(f"temperature must be positive, got {temperature}")
        self.temperature = temperature

    def forward(
        self,
        student_out: HeadOutput,
        teacher_out: HeadOutput,
        batch: object = None,
        student_features: object = None,
        teacher_features: object = None,
    ) -> torch.Tensor:
        student = flatten_levels(student_out.cls) / self.temperature
        teacher = flatten_levels(teacher_out.cls) / self.temperature
        return binary_kl(student, teacher).mean() * self.temperature**2
