"""Focal and Global Distillation on intermediate feature maps.

Plain feature imitation makes the student copy the teacher's background too, and
background is most of a WIDER FACE image. FGD splits the map with a mask built
from the ground-truth boxes and weights the two halves separately, so the
student spends its small capacity on faces.

Each ground-truth box contributes 1 / area, otherwise one crowd scene of large
faces outweighs every small face in the batch, and small faces are the hard
track the plan is graded on.
"""

from __future__ import annotations

import torch
from torch import nn
from torch.nn.functional import l1_loss, mse_loss, softmax

from facepipe.core.distiller import DistillLoss
from facepipe.core.registry import LOSSES


def foreground_mask(
    boxes: torch.Tensor, feat_hw: tuple[int, int], image_hw: tuple[int, int]
) -> torch.Tensor:
    """Per-cell weight map: 1 / box area inside each box, zero outside."""
    feat_h, feat_w = feat_hw
    mask = boxes.new_zeros(feat_h, feat_w)
    if boxes.numel() == 0:
        return mask
    scale_x = feat_w / image_hw[1]
    scale_y = feat_h / image_hw[0]
    for x1, y1, x2, y2 in boxes:
        left = int(torch.floor(x1 * scale_x).clamp(0, feat_w - 1))
        top = int(torch.floor(y1 * scale_y).clamp(0, feat_h - 1))
        right = int(torch.ceil(x2 * scale_x).clamp(left + 1, feat_w))
        bottom = int(torch.ceil(y2 * scale_y).clamp(top + 1, feat_h))
        area = (right - left) * (bottom - top)
        mask[top:bottom, left:right] = torch.maximum(
            mask[top:bottom, left:right], torch.full_like(mask[top:bottom, left:right], 1 / area)
        )
    return mask


def attention(feat: torch.Tensor, temperature: float) -> tuple[torch.Tensor, torch.Tensor]:
    """Spatial and channel attention of a feature map, each summing to its size."""
    magnitude = feat.abs()
    spatial = magnitude.mean(dim=1).flatten(1)
    spatial = softmax(spatial / temperature, dim=1) * spatial.shape[1]
    channel = magnitude.mean(dim=(2, 3))
    channel = softmax(channel / temperature, dim=1) * channel.shape[1]
    return spatial.view(feat.shape[0], 1, *feat.shape[2:]), channel[:, :, None, None]


@LOSSES.register("detection_kd_feature_fgd")
class FeatureFGDLoss(DistillLoss):
    """Masked feature imitation plus an attention-matching term."""

    def __init__(
        self,
        student_channels: list[int],
        teacher_channels: list[int],
        image_hw: tuple[int, int],
        layers: list[str] | None = None,
        teacher_layers: list[str] | None = None,
        fg_weight: float = 1.0,
        bg_weight: float = 0.5,
        attention_weight: float = 0.5,
        temperature: float = 0.5,
    ) -> None:
        super().__init__()
        if len(student_channels) != len(teacher_channels):
            raise ValueError(
                f"{len(student_channels)} student level(s) but {len(teacher_channels)} teacher"
            )
        self.layers = layers
        self.teacher_layer_names = teacher_layers
        self.image_hw = tuple(image_hw)
        self.fg_weight = fg_weight
        self.bg_weight = bg_weight
        self.attention_weight = attention_weight
        self.temperature = temperature
        self.adapters = nn.ModuleList(
            [
                nn.Conv2d(s, t, kernel_size=1)
                for s, t in zip(student_channels, teacher_channels, strict=True)
            ]
        )

    def forward(
        self,
        student_out: object = None,
        teacher_out: object = None,
        batch: object = None,
        student_features: dict[str, torch.Tensor] | None = None,
        teacher_features: dict[str, torch.Tensor] | None = None,
    ) -> torch.Tensor:
        if not student_features or not teacher_features:
            raise ValueError("feature distillation needs hooks on both student and teacher")
        names = self.layers or sorted(student_features)
        # The two models name nothing the same, so levels are paired by position
        # in the two lists rather than by a name that would have to match.
        teacher_names = self.teacher_layer_names or sorted(teacher_features)
        gt_boxes = getattr(batch, "gt_boxes", None)

        total = None
        for adapter, name, teacher_name in zip(self.adapters, names, teacher_names, strict=True):
            student = adapter(student_features[name])
            teacher = teacher_features[teacher_name]
            term = self._level_loss(student, teacher, gt_boxes)
            total = term if total is None else total + term
        return total / len(names)

    def _level_loss(
        self,
        student: torch.Tensor,
        teacher: torch.Tensor,
        gt_boxes: list[torch.Tensor] | None,
    ) -> torch.Tensor:
        spatial, channel = attention(teacher, self.temperature)
        weight = spatial * channel

        feat_hw = student.shape[-2:]
        if gt_boxes is None:
            fg = student.new_ones(student.shape[0], 1, *feat_hw)
        else:
            fg = torch.stack(
                [foreground_mask(b, feat_hw, self.image_hw) for b in gt_boxes]
            ).unsqueeze(1)
        bg = (fg == 0).to(student.dtype)

        squared = (student - teacher).pow(2) * weight
        fg_loss = (squared * fg).sum() / student.shape[0]
        bg_loss = (squared * bg).sum() / bg.sum().clamp_min(1)

        student_spatial, student_channel = attention(student, self.temperature)
        attn_loss = l1_loss(student_spatial, spatial) + l1_loss(student_channel, channel)
        return (
            self.fg_weight * fg_loss + self.bg_weight * bg_loss + self.attention_weight * attn_loss
        )


def feature_mse(student: torch.Tensor, teacher: torch.Tensor) -> torch.Tensor:
    """Unmasked imitation, the FitNets baseline arm A2 is measured against."""
    return mse_loss(student, teacher)
