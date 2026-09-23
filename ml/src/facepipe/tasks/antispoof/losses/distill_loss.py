"""Student logits pulled towards a frozen teacher's, no labels read (ADR-0003).

The pool's labels taught every student the style of CelebA-Spoof rather than
the attack medium; the imported teacher does not carry that, so its softened
distribution is the whole target and the images are only inputs.
"""

from __future__ import annotations

import torch
from torch import nn

from facepipe.core.registry import LOSSES

from .task_loss import SpoofBatch


@LOSSES.register("antispoof_distill")
class SpoofDistillLoss(nn.Module):
    """KL(teacher || student) at temperature T, scaled by T^2 as Hinton et al. do."""

    def __init__(self, temperature: float = 4.0) -> None:
        super().__init__()
        if temperature <= 0:
            raise ValueError(f"temperature must be positive, got {temperature}")
        self.temperature = float(temperature)

    def forward(
        self, output: torch.Tensor | tuple[torch.Tensor, ...], batch: SpoofBatch
    ) -> torch.Tensor:
        if batch.teacher_logits is None:
            raise ValueError(
                "antispoof_distill needs SpoofBatch.teacher_logits; set loss.teacher_run"
            )
        logits = output[0] if isinstance(output, tuple) else output
        student = nn.functional.log_softmax(logits.float() / self.temperature, dim=1)
        teacher = nn.functional.softmax(batch.teacher_logits.float() / self.temperature, dim=1)
        divergence = nn.functional.kl_div(student, teacher, reduction="batchmean")
        return divergence * self.temperature**2
