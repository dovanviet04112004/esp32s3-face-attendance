"""Anti-spoof losses. Importing this registers them under their config names."""

from .task_loss import LIVE, SPOOF, SpoofTaskLoss

__all__ = ["LIVE", "SPOOF", "SpoofTaskLoss"]
