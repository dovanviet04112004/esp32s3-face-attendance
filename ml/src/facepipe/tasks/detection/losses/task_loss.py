"""Supervised loss on real labels: focal, GIoU and landmark L1.

The only loss this branch trains on (ADR-0002), so a
regression here moves all four rows at once. Targets arrive already assigned to
priors: a loss that also decided which prior owns which face could not be tested
without reproducing that decision.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import nn
from torch.nn.functional import binary_cross_entropy_with_logits, smooth_l1_loss

from facepipe.core.registry import LOSSES

from ..model.head import HeadOutput
from ..postproc.decode import bbox_decode, flatten_output, kps_encode


@dataclass
class DetectionTargets:
    """Per-prior labels, plus the raw boxes average precision is scored against.

    landmark_mask is not redundant with labels: only 75,913 of the 159,393
    labelled faces in WIDER FACE carry landmarks, so a positive prior without
    them must contribute to the box term and not to the landmark term.
    """

    labels: torch.Tensor
    boxes: torch.Tensor
    landmarks: torch.Tensor
    landmark_mask: torch.Tensor
    priors: torch.Tensor
    gt_boxes: list[torch.Tensor] | None = None

    @property
    def positives(self) -> torch.Tensor:
        return self.labels > 0


def sigmoid_focal_loss(
    logits: torch.Tensor,
    targets: torch.Tensor,
    alpha: float = 0.25,
    gamma: float = 2.0,
) -> torch.Tensor:
    """Focal loss, summed. Faces occupy a handful of the hundreds of priors."""
    probs = logits.sigmoid()
    ce = binary_cross_entropy_with_logits(logits, targets, reduction="none")
    p_t = probs * targets + (1 - probs) * (1 - targets)
    weight = (1 - p_t).pow(gamma)
    if alpha >= 0:
        weight = weight * (alpha * targets + (1 - alpha) * (1 - targets))
    return (ce * weight).sum()


def giou_loss(pred: torch.Tensor, target: torch.Tensor, eps: float = 1e-7) -> torch.Tensor:
    """1 - GIoU, elementwise over boxes in xyxy pixels.

    GIoU rather than IoU because a predicted box that misses entirely has zero
    IoU and therefore no gradient, which is the common case early in training.
    """
    lt = torch.max(pred[..., :2], target[..., :2])
    rb = torch.min(pred[..., 2:], target[..., 2:])
    overlap = (rb - lt).clamp_min(0).prod(dim=-1)

    area_pred = (pred[..., 2:] - pred[..., :2]).clamp_min(0).prod(dim=-1)
    area_target = (target[..., 2:] - target[..., :2]).clamp_min(0).prod(dim=-1)
    union = area_pred + area_target - overlap
    iou = overlap / union.clamp_min(eps)

    enclose_lt = torch.min(pred[..., :2], target[..., :2])
    enclose_rb = torch.max(pred[..., 2:], target[..., 2:])
    enclose = (enclose_rb - enclose_lt).clamp_min(0).prod(dim=-1)
    giou = iou - (enclose - union) / enclose.clamp_min(eps)
    return 1 - giou


@LOSSES.register("detection_task")
class DetectionTaskLoss(nn.Module):
    """Weighted sum of the classification, box and landmark terms."""

    def __init__(
        self,
        cls_weight: float = 1.0,
        bbox_weight: float = 5.0,
        kps_weight: float = 1.0,
        alpha: float = 0.25,
        gamma: float = 2.0,
        beta: float = 0.1,
    ) -> None:
        super().__init__()
        self.cls_weight = cls_weight
        self.bbox_weight = bbox_weight
        self.kps_weight = kps_weight
        self.alpha = alpha
        self.gamma = gamma
        self.beta = beta

    def forward(self, model_out: HeadOutput, batch: DetectionTargets) -> torch.Tensor:
        cls_pred, bbox_pred, kps_pred = flatten_output(model_out)
        positives = batch.positives
        # Every term is divided by the same count, so their weights stay
        # comparable no matter how many faces a batch happens to hold.
        norm = positives.sum().clamp_min(1).to(cls_pred.dtype)

        cls_target = positives.to(cls_pred.dtype).unsqueeze(-1)
        loss = self.cls_weight * sigmoid_focal_loss(cls_pred, cls_target, self.alpha, self.gamma)

        if positives.any():
            priors = batch.priors
            decoded = bbox_decode(priors, bbox_pred)[positives]
            loss = loss + self.bbox_weight * giou_loss(decoded, batch.boxes[positives]).sum()

            landmarks = batch.landmark_mask & positives
            if landmarks.any():
                encoded = kps_encode(priors, batch.landmarks)
                loss = loss + self.kps_weight * smooth_l1_loss(
                    kps_pred[landmarks], encoded[landmarks], beta=self.beta, reduction="sum"
                )
        return loss / norm
