"""Anti-spoof losses. Importing this registers them under their config names."""

from .contrastive_depth_loss import ContrastiveDepthLoss, contrast_kernels
from .kd_depth_map import DepthMapDistillLoss
from .kd_logit import ScoreDistillLoss
from .task_loss import LIVE, SPOOF, SpoofTaskLoss

__all__ = [
    "LIVE",
    "SPOOF",
    "ContrastiveDepthLoss",
    "DepthMapDistillLoss",
    "ScoreDistillLoss",
    "SpoofTaskLoss",
    "contrast_kernels",
]
