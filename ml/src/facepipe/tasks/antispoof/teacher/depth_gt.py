"""Pseudo depth maps: the target CDCN++ is supervised on.

A live face is a surface with relief, so its map is a mound; an attack is flat
whatever it depicts, so its map is zeros. The mound stops at the face box - a
target spilling onto the room would ask the background to carry the label
(KEHOACH 3). CelebA-Spoof ships no depth channel, so this is a prior.
"""

from __future__ import annotations

import numpy as np

DEPTH_SIZE = 32
LIVE, SPOOF = 0, 1
# A fraction of the face box, not of the map, so the mound keeps its shape as
# the crop scale moves.
SIGMA_OF_FACE = 0.28


def _grid(size: int) -> tuple[np.ndarray, np.ndarray]:
    axis = (np.arange(size, dtype=np.float32) + 0.5) / size - 0.5
    return np.meshgrid(axis, axis, indexing="ij")


def face_mask(wide_scale, size: int = DEPTH_SIZE) -> np.ndarray:
    """True over the face box, which sits centred in the crop by construction.

    Args:
        wide_scale: the scale the wide crop reached, one value or one per sample.
    """
    grid_y, grid_x = _grid(size)
    half = 0.5 / np.asarray(wide_scale, dtype=np.float32)[..., None, None]
    return (np.abs(grid_x) <= half) & (np.abs(grid_y) <= half)


def gaussian_map(
    wide_scale, size: int = DEPTH_SIZE, sigma: float = SIGMA_OF_FACE
) -> np.ndarray:
    """A mound peaking at the centre of the face box and zero outside it.

    Sigma is read against the box, so at 0.28 the mound has fallen to about 0.05
    by the corner of the box whatever scale the crop reached.
    """
    grid_y, grid_x = _grid(size)
    spread = sigma / np.asarray(wide_scale, dtype=np.float32)[..., None, None]
    squared = (grid_x**2 + grid_y**2) / (2.0 * spread**2)
    return (np.exp(-squared) * face_mask(wide_scale, size)).astype(np.float32)


def live_reference_mean(wide_scale, size: int = DEPTH_SIZE, sigma: float = SIGMA_OF_FACE):
    """Mean of a perfect live map, the value a liveness score of 1 corresponds to.

    Anything reading the mean as a probability divides by this first. A wider
    crop holds a smaller face and a smaller mean, so the two travel together.
    """
    return gaussian_map(wide_scale, size, sigma).mean(axis=(-2, -1))


def depth_target(
    label: int, wide_scale: float, size: int = DEPTH_SIZE, sigma: float = SIGMA_OF_FACE
) -> np.ndarray:
    """The map one sample is supervised against, by class."""
    if label == SPOOF:
        return np.zeros((size, size), dtype=np.float32)
    return gaussian_map(wide_scale, size, sigma)


def depth_batch(
    labels: np.ndarray, wide_scale, size: int = DEPTH_SIZE, sigma: float = SIGMA_OF_FACE
) -> np.ndarray:
    """One map per label, stacked, each at its own sample's crop scale."""
    labels = np.asarray(labels)
    scales = np.broadcast_to(np.asarray(wide_scale, dtype=np.float32), labels.shape)
    maps = gaussian_map(scales, size, sigma)
    return np.where(labels[:, None, None] == LIVE, maps, 0.0).astype(np.float32)
