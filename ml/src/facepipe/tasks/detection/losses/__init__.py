"""Detection losses. Importing this registers them under their config names."""

from .task_loss import DetectionTargets, DetectionTaskLoss, giou_loss, sigmoid_focal_loss

__all__ = [
    "DetectionTargets",
    "DetectionTaskLoss",
    "giou_loss",
    "sigmoid_focal_loss",
]
