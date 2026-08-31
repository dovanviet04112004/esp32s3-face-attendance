"""Recognition losses. Importing this registers them under their config names."""

from .arcface import ArcFaceLoss
from .kd_embedding import EmbeddingDistillLoss
from .kd_relation_rkd import RelationDistillLoss, pairwise_angles, pairwise_distances

__all__ = [
    "ArcFaceLoss",
    "EmbeddingDistillLoss",
    "RelationDistillLoss",
    "pairwise_angles",
    "pairwise_distances",
]
