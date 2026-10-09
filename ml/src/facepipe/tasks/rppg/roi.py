"""Skin regions from the detector's five landmarks, and their mean colour per frame."""

from __future__ import annotations

import numpy as np

from .config import Region

# Under half a region left inside the frame says more about the frame edge than the skin.
MIN_INSIDE = 0.5


def region_boxes(landmarks: np.ndarray, regions: dict[str, Region]) -> np.ndarray:
    """(n_regions, 4) x0, y0, x1, y1 in image pixels, in the order `regions` lists them.

    Placed from the eye midpoint in eye distances, so a closer face scales its patches
    with it; the two eyes are the first two of the five landmarks.
    """
    eyes = np.asarray(landmarks, dtype=np.float64)[:2]
    mid = eyes.mean(axis=0)
    distance = float(np.linalg.norm(eyes[1] - eyes[0]))
    boxes = []
    for region in regions.values():
        cx = mid[0] + region.centre[0] * distance
        cy = mid[1] + region.centre[1] * distance
        half_w, half_h = region.size[0] * distance / 2, region.size[1] * distance / 2
        boxes.append((cx - half_w, cy - half_h, cx + half_w, cy + half_h))
    return np.asarray(boxes, dtype=np.float64)


def region_means(image: np.ndarray, boxes: np.ndarray) -> np.ndarray:
    """(n_regions, 3) mean of each box over an HxWx3 image; NaN where it left the frame."""
    height, width = image.shape[:2]
    means = np.full((len(boxes), 3), np.nan)
    for index, (x0, y0, x1, y1) in enumerate(boxes):
        area = max(x1 - x0, 0.0) * max(y1 - y0, 0.0)
        left, top = max(int(np.floor(x0)), 0), max(int(np.floor(y0)), 0)
        right, bottom = min(int(np.ceil(x1)), width), min(int(np.ceil(y1)), height)
        if area <= 0 or right <= left or bottom <= top:
            continue
        if (right - left) * (bottom - top) < MIN_INSIDE * area:
            continue
        means[index] = image[top:bottom, left:right].reshape(-1, image.shape[2]).mean(axis=0)
    return means
