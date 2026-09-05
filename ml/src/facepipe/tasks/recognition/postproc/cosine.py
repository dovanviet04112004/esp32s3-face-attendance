"""Comparing an embedding against the enrolled templates.

Must stay identical to svc_facedb/src/embedding_index.cpp. Templates are int8
with a per-record scale (KEHOACH 6.2.4), and that scale never enters the
similarity: cosine measures angle, so a positive factor cancels. The device
compares int8 to int8 with an int32 accumulator and one float divide.
"""

from __future__ import annotations

import numpy as np

INT8_MAX = 127


def quantize(embedding: np.ndarray) -> tuple[np.ndarray, float]:
    """Symmetric per-vector int8, returning the scale a record stores.

    Per vector, not per dimension: a template is one row, and the device has one
    f32 scale per record to dequantise it with.
    """
    values = np.asarray(embedding, dtype=np.float32)
    peak = float(np.abs(values).max())
    if peak == 0.0:
        return np.zeros(values.shape, dtype=np.int8), 0.0
    scale = peak / INT8_MAX
    quantized = np.rint(values / scale).clip(-INT8_MAX, INT8_MAX).astype(np.int8)
    return quantized, scale


def dequantize(quantized: np.ndarray, scale: float) -> np.ndarray:
    """The float vector a stored record stands for."""
    return np.asarray(quantized, dtype=np.float32) * np.float32(scale)


def cosine_int8(query: np.ndarray, template: np.ndarray) -> float:
    """Similarity of two int8 templates, accumulated the way the device does."""
    a = np.asarray(query, dtype=np.int32)
    b = np.asarray(template, dtype=np.int32)
    dot = int((a * b).sum())
    norm = float(np.sqrt(float((a * a).sum()) * float((b * b).sum())))
    return dot / norm if norm > 0 else 0.0


def cosine(query: np.ndarray, gallery: np.ndarray) -> np.ndarray:
    """Similarity of one float embedding against a gallery, one row per template."""
    a = np.asarray(query, dtype=np.float32).reshape(1, -1)
    b = np.asarray(gallery, dtype=np.float32).reshape(len(np.atleast_2d(gallery)), -1)
    numerator = (b @ a.ravel()).astype(np.float64)
    denominator = np.linalg.norm(b, axis=1) * np.linalg.norm(a)
    return np.divide(numerator, denominator, out=np.zeros_like(numerator), where=denominator > 0)


def best_match(query: np.ndarray, gallery: np.ndarray) -> tuple[int, float]:
    """Index and score of the closest template, or (-1, -1.0) for an empty gallery."""
    if len(np.atleast_2d(gallery)) == 0:
        return -1, -1.0
    scores = cosine(query, gallery)
    index = int(scores.argmax())
    return index, float(scores[index])
