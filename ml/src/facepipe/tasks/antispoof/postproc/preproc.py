"""Face crop and area resample, the mirror of ai_engine/src/antispoof/preproc.cpp.

The device reads RGB565 words and averages whole source pixels per destination
cell; PIL's reduction filter answers a slightly different question, so the crop
the board sees is reproduced here rather than borrowed from the training path.
"""

from __future__ import annotations

import numpy as np

FACE_SCALE = 1.0
CHANNELS = 3


def unpack_rgb565(words: np.ndarray) -> np.ndarray:
    """The 8-bit channels of each word, high bits replicated into the low ones."""
    red = (words >> 11) & 0x1F
    green = (words >> 5) & 0x3F
    blue = words & 0x1F
    return np.stack(
        [(red << 3) | (red >> 2), (green << 2) | (green >> 4), (blue << 3) | (blue >> 2)],
        axis=-1,
    ).astype(np.uint16)


def fitted_square(
    box: np.ndarray, scale: float, width: int, height: int
) -> tuple[float, float, float]:
    """Left, top and side of the largest square that fits, slid to hold the face."""
    cx, cy = (box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0
    face = max(1.0, max(box[2] - box[0], box[3] - box[1]))
    side = max(1.0, np.floor(min(face * scale, float(width), float(height))))
    left = min(max(0.0, float(np.rint(cx - side / 2.0))), width - side)
    top = min(max(0.0, float(np.rint(cy - side / 2.0))), height - side)
    return left, top, side


def cell_bounds(
    origin: float, span: float, count: int, limit: int
) -> tuple[np.ndarray, np.ndarray]:
    """Inclusive source index range covering each destination cell.

    float32 and `lo + step` rather than `origin + (i + 1) * step`: the device
    computes it that way, and on the last cell the two disagree by a pixel.
    """
    step = np.float32(span) / np.float32(count)
    # xtensa contracts origin + i * step into one madd.s, so the product and the
    # sum round once between them; float64 here reproduces that single rounding.
    low = (np.float64(origin) + np.arange(count, dtype=np.float64) * np.float64(step)).astype(
        np.float32
    )
    high = low + step
    first = np.clip(np.floor(low).astype(np.int64), 0, limit - 1)
    last = np.clip(np.ceil(high).astype(np.int64) - 1, 0, limit - 1)
    return first, np.maximum(first, last)


def resample_square(rgb: np.ndarray, left: float, top: float, side: float, size: int) -> np.ndarray:
    """Area-average the square onto size x size, rounding each mean half up."""
    height, width = rgb.shape[:2]
    col_first, col_last = cell_bounds(left, side, size, width)
    row_first, row_last = cell_bounds(top, side, size, height)
    rows = np.cumsum(np.pad(rgb.astype(np.int64), ((1, 0), (0, 0), (0, 0))), axis=0)
    block = np.empty((size, size, CHANNELS), dtype=np.uint8)
    for r in range(size):
        strip = rows[row_last[r] + 1] - rows[row_first[r]]
        columns = np.cumsum(np.pad(strip, ((1, 0), (0, 0))), axis=0)
        total = columns[col_last + 1] - columns[col_first]
        count = ((col_last - col_first + 1) * (row_last[r] - row_first[r] + 1))[:, None]
        block[r] = ((total + count // 2) // count).astype(np.uint8)
    return block


def quantize(
    block: np.ndarray, scale: float, zero_point: int, mean: float, span: float
) -> np.ndarray:
    """The int8 the Quantizer of pixels.cpp writes for each byte."""
    scaled = (block.astype(np.float32) - np.float32(mean)) / np.float32(span) / np.float32(scale)
    return np.clip(np.rint(scaled) + zero_point, -128, 127).astype(np.int8)


def crop_face(
    words: np.ndarray,
    box: np.ndarray,
    size: int,
    scale: float,
    zero_point: int,
    mean: float = 0.0,
    span: float = 255.0,
) -> np.ndarray:
    """The int8 block crop_face hands the interpreter, from one RGB565 frame."""
    height, width = words.shape
    left, top, side = fitted_square(box, FACE_SCALE, width, height)
    block = resample_square(unpack_rgb565(words), left, top, side, size)
    return quantize(block, scale, zero_point, mean, span)
