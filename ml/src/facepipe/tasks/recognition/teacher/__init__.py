"""Recognition teacher. Importing this registers it under "r50_wf600k"."""

from .r50_wf600k import (
    EMBEDDING_DIM,
    INPUT_SIZE,
    CachedEmbedding,
    IBasicBlock,
    IResNet,
    load_r50_wf600k,
    normalize_pixels,
)

__all__ = [
    "EMBEDDING_DIM",
    "INPUT_SIZE",
    "CachedEmbedding",
    "IBasicBlock",
    "IResNet",
    "load_r50_wf600k",
    "normalize_pixels",
]
