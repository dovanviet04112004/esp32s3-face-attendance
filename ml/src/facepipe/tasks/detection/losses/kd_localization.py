"""Geometry distillation: box corners and all five landmarks.

The landmarks decide how a face is aligned before MobileFaceNet sees it, so a
student that finds faces but places eyes badly costs recognition accuracy no
later stage recovers. Comparison happens in pixels: the teacher regresses from
its own priors, so its raw offsets mean something else than the student's.
"""

from __future__ import annotations

import torch
from torch.nn.functional import smooth_l1_loss

from facepipe.core.distiller import DistillLoss
from facepipe.core.registry import LOSSES

from ..postproc.decode import bbox_decode, flatten_output, kps_decode
from ..student.head import HeadOutput


@LOSSES.register("detection_kd_localization")
class LocalizationDistillLoss(DistillLoss):
    """Smooth L1 on decoded boxes and landmarks, gated by teacher confidence.

    Imitating the teacher everywhere would spend most of the loss on background
    priors, where its box output is arbitrary. The gate keeps only priors the
    teacher scores above a threshold and weights each by that score.
    """

    def __init__(
        self,
        bbox_weight: float = 1.0,
        kps_weight: float = 1.0,
        score_threshold: float = 0.3,
        beta: float = 1.0,
    ) -> None:
        super().__init__()
        self.bbox_weight = bbox_weight
        self.kps_weight = kps_weight
        self.score_threshold = score_threshold
        self.beta = beta

    def forward(
        self,
        student_out: HeadOutput,
        teacher_out: HeadOutput,
        batch: object = None,
        student_features: object = None,
        teacher_features: object = None,
    ) -> torch.Tensor:
        priors = getattr(batch, "priors", None)
        if priors is None:
            raise ValueError("localization distillation needs batch.priors to decode with")

        _, student_bbox, student_kps = flatten_output(student_out)
        teacher_cls, teacher_bbox, teacher_kps = flatten_output(teacher_out)

        scores = teacher_cls.sigmoid().squeeze(-1)
        gate = scores >= self.score_threshold
        if not gate.any():
            return student_bbox.sum() * 0.0

        weight = scores[gate].unsqueeze(-1)
        norm = weight.sum().clamp_min(1e-6)

        box_term = smooth_l1_loss(
            bbox_decode(priors, student_bbox)[gate],
            bbox_decode(priors, teacher_bbox)[gate],
            beta=self.beta,
            reduction="none",
        )
        kps_term = smooth_l1_loss(
            kps_decode(priors, student_kps)[gate],
            kps_decode(priors, teacher_kps)[gate],
            beta=self.beta,
            reduction="none",
        )
        box_loss = (box_term * weight).sum() / norm
        kps_loss = (kps_term * weight).sum() / norm
        return self.bbox_weight * box_loss + self.kps_weight * kps_loss
