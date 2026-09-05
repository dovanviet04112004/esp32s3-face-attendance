"""Embedding normalisation, the last step before anything is compared.

Must stay identical to ai_engine/src/recognition/l2norm.cpp. Vector length
carries no identity - two exposures of one face differ in length more than two
faces differ in direction - so it is divided out once, here (KEHOACH 4.5.6). The
floor keeps a dead frame at zero instead of a unit vector pointing anywhere.
"""

from __future__ import annotations

import numpy as np

NORM_EPS = 1e-10


def l2_normalize(embedding: np.ndarray, eps: float = NORM_EPS) -> np.ndarray:
    """Scale each row to unit length, in float32 as the device does."""
    values = np.asarray(embedding, dtype=np.float32)
    squeeze = values.ndim == 1
    rows = values.reshape(1, -1) if squeeze else values
    norms = np.sqrt((rows.astype(np.float64) ** 2).sum(axis=1, keepdims=True))
    unit = (rows / np.maximum(norms, eps)).astype(np.float32)
    return unit[0] if squeeze else unit
