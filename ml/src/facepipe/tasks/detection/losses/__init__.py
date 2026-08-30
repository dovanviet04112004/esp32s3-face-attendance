"""Detection losses. Importing this registers all four under their config names."""

from .kd_feature_fgd import FeatureFGDLoss, attention, foreground_mask
from .kd_localization import LocalizationDistillLoss
from .kd_logit import LogitDistillLoss, binary_kl
from .task_loss import DetectionTargets, DetectionTaskLoss, giou_loss, sigmoid_focal_loss

__all__ = [
    "DetectionTargets",
    "DetectionTaskLoss",
    "FeatureFGDLoss",
    "LocalizationDistillLoss",
    "LogitDistillLoss",
    "attention",
    "binary_kl",
    "foreground_mask",
    "giou_loss",
    "sigmoid_focal_loss",
]
