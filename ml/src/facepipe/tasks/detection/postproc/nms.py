"""Greedy non-maximum suppression over decoded boxes.

Must stay identical to ai_engine/src/detection/nms.cpp, or the same picture
yields a different face count on the device. One class, so no per-class
partitioning. Ties break by index: two priors can carry bit-identical scores
after quantisation, and an unstable sort would keep a different one on each side.
"""

from __future__ import annotations

import numpy as np


def box_iou(boxes: np.ndarray, box: np.ndarray) -> np.ndarray:
    """Overlap of one xyxy box against many, as a fraction of their union."""
    if not len(boxes):
        return np.zeros(0, dtype=np.float64)
    left = np.maximum(boxes[:, 0], box[0])
    top = np.maximum(boxes[:, 1], box[1])
    right = np.minimum(boxes[:, 2], box[2])
    bottom = np.minimum(boxes[:, 3], box[3])

    overlap = np.clip(right - left, 0, None) * np.clip(bottom - top, 0, None)
    areas = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    union = areas + (box[2] - box[0]) * (box[3] - box[1]) - overlap
    return np.where(union > 0, overlap / np.maximum(union, 1e-12), 0.0)


def nms(boxes: np.ndarray, scores: np.ndarray, iou_threshold: float = 0.3) -> np.ndarray:
    """Indices to keep, highest score first."""
    if not len(boxes):
        return np.zeros(0, dtype=np.int64)
    order = np.lexsort((np.arange(len(scores)), -np.asarray(scores, dtype=np.float64)))

    keep: list[int] = []
    while order.size:
        best = int(order[0])
        keep.append(best)
        if order.size == 1:
            break
        rest = order[1:]
        order = rest[box_iou(boxes[rest], boxes[best]) <= iou_threshold]
    return np.asarray(keep, dtype=np.int64)


def top_k(scores: np.ndarray, limit: int) -> np.ndarray:
    """Indices of the highest scores, sorted, for capping work before NMS.

    The device has a fixed detection budget, so the cap belongs before the
    quadratic step rather than after it.
    """
    if limit <= 0 or len(scores) <= limit:
        return np.lexsort((np.arange(len(scores)), -np.asarray(scores, dtype=np.float64)))
    partition = np.argpartition(-np.asarray(scores, dtype=np.float64), limit)[:limit]
    return partition[np.lexsort((partition, -np.asarray(scores)[partition]))]
