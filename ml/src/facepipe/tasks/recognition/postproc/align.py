"""Five landmarks to an aligned face crop.

Must stay identical to ai_engine/src/recognition/align.cpp: aligning differently
puts the two sides' embeddings in different distributions. Reference points are
ArcFace's, the geometry MS1MV3 was packed with. The transform is a similarity -
a full affine would shear a face to fit and lose the shape the embedding carries.
"""

from __future__ import annotations

import numpy as np

ALIGNED_SIZE = 113
# The reference points below are ArcFace's, laid out on a 112 grid.
REFERENCE_BASIS = 112

# Left eye, right eye, nose, left mouth corner, right mouth corner, in the order
# the detector emits them.
REFERENCE_LANDMARKS = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float64,
)


def reference_landmarks(size: int = ALIGNED_SIZE) -> np.ndarray:
    """The target points, scaled from the 112 grid they are defined on."""
    return REFERENCE_LANDMARKS * (size / REFERENCE_BASIS)


def similarity_transform(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    """Umeyama least-squares similarity, returned as a 2x3 matrix.

    The reflection guard is not optional: with five points from a profile face the
    covariance can come out negative-determinant, and the unguarded solution then
    mirrors the face, which reads as a different person.
    """
    source = np.asarray(source, dtype=np.float64).reshape(-1, 2)
    target = np.asarray(target, dtype=np.float64).reshape(-1, 2)
    count = len(source)

    source_mean, target_mean = source.mean(axis=0), target.mean(axis=0)
    source_demean, target_demean = source - source_mean, target - target_mean

    covariance = target_demean.T @ source_demean / count
    u, singular, vt = np.linalg.svd(covariance)
    signs = np.ones(2)
    if np.linalg.det(covariance) < 0:
        signs[-1] = -1.0
    rotation = u @ np.diag(signs) @ vt

    variance = (source_demean**2).sum() / count
    scale = float((singular * signs).sum() / variance) if variance > 0 else 1.0

    matrix = np.zeros((2, 3), dtype=np.float64)
    matrix[:, :2] = scale * rotation
    matrix[:, 2] = target_mean - scale * rotation @ source_mean
    return matrix


def invert_affine(matrix: np.ndarray) -> np.ndarray:
    """The 2x3 inverse, which is what a destination-driven warp actually needs."""
    linear = matrix[:, :2]
    inverse_linear = np.linalg.inv(linear)
    out = np.zeros((2, 3), dtype=np.float64)
    out[:, :2] = inverse_linear
    out[:, 2] = -inverse_linear @ matrix[:, 2]
    return out


def warp_affine(image: np.ndarray, matrix: np.ndarray, size: int = ALIGNED_SIZE) -> np.ndarray:
    """Bilinear warp, sampling the source at each destination pixel.

    Walking the destination is what makes the output gapless; walking the source
    and writing forward leaves holes wherever the scale is above one.
    """
    inverse = invert_affine(matrix)
    grid_y, grid_x = np.meshgrid(np.arange(size), np.arange(size), indexing="ij")
    flat = np.stack((grid_x.ravel(), grid_y.ravel()), axis=1).astype(np.float64)
    source = flat @ inverse[:, :2].T + inverse[:, 2]

    height, width = image.shape[:2]
    x, y = source[:, 0], source[:, 1]
    x0, y0 = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    x1, y1 = x0 + 1, y0 + 1
    # Clamping to the border rather than dropping out-of-range samples keeps the
    # output complete for a face that touches the edge of the frame.
    fx, fy = x - x0, y - y0
    x0, x1 = np.clip(x0, 0, width - 1), np.clip(x1, 0, width - 1)
    y0, y1 = np.clip(y0, 0, height - 1), np.clip(y1, 0, height - 1)

    pixels = image.astype(np.float64)
    top = pixels[y0, x0] * (1 - fx)[:, None] + pixels[y0, x1] * fx[:, None]
    bottom = pixels[y1, x0] * (1 - fx)[:, None] + pixels[y1, x1] * fx[:, None]
    blended = top * (1 - fy)[:, None] + bottom * fy[:, None]
    return np.clip(blended, 0, 255).reshape(size, size, -1).astype(image.dtype)


def align(image: np.ndarray, landmarks: np.ndarray, size: int = ALIGNED_SIZE) -> np.ndarray:
    """Crop and rectify one face onto the reference geometry."""
    matrix = similarity_transform(landmarks, reference_landmarks(size))
    return warp_affine(image, matrix, size)
