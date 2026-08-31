"""Embedding normalisation, the last step before anything is compared.

Must stay identical to ai_engine/src/recognition/l2norm.cpp. The network emits an
unnormalised vector whose length carries no identity: two captures of one face
under different exposure differ in length far more than two faces differ in
direction. Every comparison downstream is angular, so the length is divided out
once, here, rather than being carried into a similarity that would have to undo
it (KEHOACH section 4.5.6).

The floor on the norm is what keeps a dead frame from producing infinities: a
zero embedding stays zero instead of becoming a unit vector pointing anywhere.
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
