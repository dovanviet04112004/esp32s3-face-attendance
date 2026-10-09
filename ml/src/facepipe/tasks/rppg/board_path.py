"""The board's view of a face, simulated from a phone video (KEHOACH 3).

Scaled to the face width the OV5640 draws at a given distance, given the sensor
noise measured on a flat patch, then cut to RGB565. A stand-in for deciding
whether board capture is worth it, never for the board's own numbers.
"""

from __future__ import annotations

import numpy as np

RGB565_BITS = (5, 6, 5)
# Room the crop keeps around the detector box, so the forehead above it survives.
CROP_MARGIN = 0.6


def rgb565_levels(image8: np.ndarray, noise_lsb: float, rng: np.random.Generator) -> np.ndarray:
    """An HxWx3 uint8 image as the sensor would hand it over, in [0, 1] per channel.

    Noise is drawn per pixel in each channel's own LSB before truncation, which is
    what lets a region mean move by less than one level.
    """
    out = np.empty(image8.shape, dtype=np.float32)
    for channel, bits in enumerate(RGB565_BITS):
        step = 2 ** (8 - bits)
        value = image8[..., channel].astype(np.float32) / step
        if noise_lsb > 0:
            value = value + rng.normal(0.0, noise_lsb, size=value.shape).astype(np.float32)
        top = 2**bits - 1
        out[..., channel] = np.clip(np.floor(value), 0, top) / top
    return out


def board_view(
    image8: np.ndarray,
    box: np.ndarray,
    face_px: int,
    noise_lsb: float,
    rng: np.random.Generator,
) -> tuple[np.ndarray, np.ndarray, float]:
    """The face drawn `face_px` wide in RGB565 levels, with the crop origin and scale.

    A point (x, y) of the source maps to ((x, y) - origin) * scale in the view.
    """
    import cv2

    height, width = image8.shape[:2]
    x0, y0, x1, y1 = (float(v) for v in box[:4])
    pad_w, pad_h = (x1 - x0) * CROP_MARGIN, (y1 - y0) * CROP_MARGIN
    left, top = max(int(x0 - pad_w), 0), max(int(y0 - pad_h), 0)
    right, bottom = min(int(np.ceil(x1 + pad_w)), width), min(int(np.ceil(y1 + pad_h)), height)
    scale = face_px / max(x1 - x0, 1.0)
    crop = image8[top:bottom, left:right]
    size = (max(round(crop.shape[1] * scale), 1), max(round(crop.shape[0] * scale), 1))
    small = cv2.resize(crop, size, interpolation=cv2.INTER_AREA)
    return rgb565_levels(small, noise_lsb, rng), np.array([left, top], dtype=np.float64), scale
