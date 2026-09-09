"""Recognition losses. Importing this registers them under their config names."""

from .arcface import ArcFaceLoss

__all__ = ["ArcFaceLoss"]
