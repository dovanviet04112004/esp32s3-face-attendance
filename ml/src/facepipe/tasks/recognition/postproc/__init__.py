"""Post-processing that must match the C implementation in ai_engine and svc_facedb."""

from .align import (
    ALIGNED_SIZE,
    REFERENCE_LANDMARKS,
    align,
    invert_affine,
    reference_landmarks,
    similarity_transform,
    warp_affine,
)
from .cosine import best_match, cosine, cosine_int8, dequantize, quantize
from .l2norm import NORM_EPS, l2_normalize

__all__ = [
    "ALIGNED_SIZE",
    "NORM_EPS",
    "REFERENCE_LANDMARKS",
    "align",
    "best_match",
    "cosine",
    "cosine_int8",
    "dequantize",
    "invert_affine",
    "l2_normalize",
    "quantize",
    "reference_landmarks",
    "similarity_transform",
    "warp_affine",
]
