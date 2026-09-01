"""Pseudo depth maps: the target CDCN++ is supervised on.

CDCN++ regresses a depth map rather than a class. A live face is a surface with
relief, so its map is a mound over the face; an attack is a photograph or a
screen, flat whatever it depicts, so its map is all zeros.

The mound stops at the face box. The teacher reads the wide crop, where the box
covers one part in CROP_SCALES["wide"] of each side, and a target spilling onto
the room around it would ask the background to carry the label (KEHOACH 3).

CelebA-Spoof ships no depth channel, so this is a prior, not a measurement.
"""

from __future__ import annotations

import numpy as np

from facepipe.data.prepare.celeba_spoof_parquet import CROP_SCALES

DEPTH_SIZE = 32
LIVE, SPOOF = 0, 1
FACE_FRACTION = 1.0 / CROP_SCALES["wide"]
# A fraction of the face box, not of the map, so the mound keeps its shape if
# the crop scale moves.
SIGMA_OF_FACE = 0.28


def face_mask(size: int = DEPTH_SIZE, fraction: float = FACE_FRACTION) -> np.ndarray:
    """True over the face box, which sits centred in the crop by construction."""
    axis = (np.arange(size, dtype=np.float32) + 0.5) / size - 0.5
    grid_y, grid_x = np.meshgrid(axis, axis, indexing="ij")
    half = fraction / 2.0
    return (np.abs(grid_x) <= half) & (np.abs(grid_y) <= half)


def gaussian_map(
    size: int = DEPTH_SIZE, sigma: float = SIGMA_OF_FACE, fraction: float = FACE_FRACTION
) -> np.ndarray:
    """A mound peaking at the centre of the face box and zero outside it.

    Sigma is read against the box, so at 0.28 the mound has fallen to about 0.05
    by the corner of the box.
    """
    axis = (np.arange(size, dtype=np.float32) + 0.5) / size - 0.5
    grid_y, grid_x = np.meshgrid(axis, axis, indexing="ij")
    spread = sigma * fraction
    squared = (grid_x**2 + grid_y**2) / (2.0 * spread**2)
    return (np.exp(-squared) * face_mask(size, fraction)).astype(np.float32)


def live_reference_mean(size: int = DEPTH_SIZE, sigma: float = SIGMA_OF_FACE) -> float:
    """Mean of a perfect live map, the value a liveness score of 1 corresponds to.

    Anything reading the mean as a probability divides by this first. It moves
    with the crop scale, so scores compare only within one target recipe.
    """
    return float(gaussian_map(size, sigma).mean())


def depth_target(label: int, size: int = DEPTH_SIZE, sigma: float = SIGMA_OF_FACE) -> np.ndarray:
    """The map one sample is supervised against, by class."""
    if label == SPOOF:
        return np.zeros((size, size), dtype=np.float32)
    return gaussian_map(size, sigma)


def depth_batch(
    labels: np.ndarray, size: int = DEPTH_SIZE, sigma: float = SIGMA_OF_FACE
) -> np.ndarray:
    """One map per label, stacked. The mound is built once and shared."""
    mound = gaussian_map(size, sigma)
    maps = np.zeros((len(labels), size, size), dtype=np.float32)
    maps[np.asarray(labels) == LIVE] = mound
    return maps
