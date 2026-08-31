"""Pseudo depth maps: the target CDCN++ is supervised on.

CDCN++ does not classify, it regresses a depth map, and the two classes get very
different targets. A live face is a surface with relief, so its map is a smooth
mound centred on the face. An attack is a photograph or a screen, which is flat
whatever it depicts, so its map is all zeros. A model that learns to tell those
two maps apart has learned the geometry rather than the texture, which is what
survives a print it has never seen (KEHOACH section 1.1).

CelebA-Spoof ships no depth channel, so this is a prior, not a measurement.
Calling it ground truth is the field's convention and not a claim about accuracy:
the map only has to be flat for attacks and not flat for live faces.
"""

from __future__ import annotations

import numpy as np

DEPTH_SIZE = 32
LIVE, SPOOF = 0, 1


def gaussian_map(size: int = DEPTH_SIZE, sigma: float = 0.28) -> np.ndarray:
    """A mound peaking at the centre and falling to nearly zero at the border.

    Sigma is a fraction of the map, so the shape stays the same if the size
    changes. At 0.28 the corners sit near 0.05, low enough that a border pixel
    carries no signal but not so low that the loss ignores the face outline.
    """
    axis = (np.arange(size, dtype=np.float32) + 0.5) / size - 0.5
    grid_y, grid_x = np.meshgrid(axis, axis, indexing="ij")
    squared = (grid_x**2 + grid_y**2) / (2.0 * sigma**2)
    return np.exp(-squared).astype(np.float32)


def live_reference_mean(size: int = DEPTH_SIZE, sigma: float = 0.28) -> float:
    """Mean of a perfect live map, the value a liveness score of 1 corresponds to.

    A mound averaged over the whole map is about 0.42, not 1: most of the map is
    the border, where the mound has already fallen off. Anything reading the mean
    as a probability has to divide by this first.
    """
    return float(gaussian_map(size, sigma).mean())


def depth_target(label: int, size: int = DEPTH_SIZE, sigma: float = 0.28) -> np.ndarray:
    """The map one sample is supervised against, by class."""
    if label == SPOOF:
        return np.zeros((size, size), dtype=np.float32)
    return gaussian_map(size, sigma)


def depth_batch(labels: np.ndarray, size: int = DEPTH_SIZE, sigma: float = 0.28) -> np.ndarray:
    """One map per label, stacked. The mound is built once and shared."""
    mound = gaussian_map(size, sigma)
    maps = np.zeros((len(labels), size, size), dtype=np.float32)
    maps[np.asarray(labels) == LIVE] = mound
    return maps
