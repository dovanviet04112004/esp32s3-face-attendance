"""Make clean dataset images look like OV5640 frames.

WIDER FACE and Glint360K are sharp, well exposed web photos; the kiosk sees a
small rolling-shutter sensor behind a cheap lens at 20 MHz XCLK. Every effect is
seeded, so an augmented sample is reproducible from the seed and index alone.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np

MAX_UINT8 = 255


@dataclass
class SensorSimConfig:
    """Strength of each effect. Ranges are sampled per call."""

    jpeg_quality: tuple[int, int] = (35, 80)
    gaussian_noise_sigma: tuple[float, float] = (2.0, 9.0)
    blur_sigma: tuple[float, float] = (0.0, 1.2)
    brightness_gain: tuple[float, float] = (0.6, 1.25)
    white_balance_shift: tuple[float, float] = (-0.08, 0.08)
    vignette_strength: tuple[float, float] = (0.0, 0.35)
    probability: float = 0.9


def _uniform(rng: np.random.Generator, span: tuple[float, float]) -> float:
    return float(rng.uniform(span[0], span[1]))


def _convolve1d(image: np.ndarray, kernel: np.ndarray, axis: int) -> np.ndarray:
    radius = len(kernel) // 2
    padding = [(0, 0)] * image.ndim
    padding[axis] = (radius, radius)
    padded = np.pad(image, padding, mode="edge")
    out = np.zeros_like(image, dtype=np.float32)
    for offset, weight in enumerate(kernel):
        window = [slice(None)] * image.ndim
        window[axis] = slice(offset, offset + image.shape[axis])
        out += float(weight) * padded[tuple(window)]
    return out


def gaussian_blur(image: np.ndarray, sigma: float) -> np.ndarray:
    """Separable Gaussian blur, standing in for a lens that never quite focuses."""
    source = image.astype(np.float32)
    if sigma <= 0:
        return source
    radius = max(1, round(sigma * 3))
    offsets = np.arange(-radius, radius + 1, dtype=np.float32)
    kernel = np.exp(-(offsets**2) / (2 * sigma**2))
    kernel /= kernel.sum()
    return _convolve1d(_convolve1d(source, kernel, 0), kernel, 1)


def vignette(image: np.ndarray, strength: float) -> np.ndarray:
    """Darken the corners the way a small lens does wide open."""
    if strength <= 0:
        return image
    height, width = image.shape[:2]
    ys = np.linspace(-1.0, 1.0, height, dtype=np.float32)[:, None]
    xs = np.linspace(-1.0, 1.0, width, dtype=np.float32)[None, :]
    radius = np.sqrt(xs**2 + ys**2) / np.sqrt(2.0)
    mask = 1.0 - strength * radius**2
    return image.astype(np.float32) * mask[:, :, None]


def white_balance(image: np.ndarray, shift: float) -> np.ndarray:
    """Push red up and blue down, or the reverse, as auto white balance drifts."""
    gains = np.array([1.0 + shift, 1.0, 1.0 - shift], dtype=np.float32)
    return image.astype(np.float32) * gains[None, None, :]


def jpeg_cycle(image: np.ndarray, quality: int) -> np.ndarray:
    """Re-encode through JPEG, which is what the camera actually hands over."""
    from PIL import Image

    buffer = io.BytesIO()
    Image.fromarray(np.clip(image, 0, MAX_UINT8).astype(np.uint8)).save(
        buffer, format="JPEG", quality=int(quality)
    )
    buffer.seek(0)
    with Image.open(buffer) as decoded:
        return np.asarray(decoded.convert("RGB"), dtype=np.uint8)


def simulate(image: np.ndarray, seed: int, config: SensorSimConfig | None = None) -> np.ndarray:
    """Apply the whole chain in capture order and return a uint8 RGB image.

    Order matters: noise and blur belong to the sensor and lens, so they happen
    before the JPEG encoder rather than after it.
    """
    cfg = config or SensorSimConfig()
    rng = np.random.default_rng(seed)
    if rng.random() > cfg.probability:
        return image.astype(np.uint8)

    out = image.astype(np.float32)
    out = out * _uniform(rng, cfg.brightness_gain)
    out = white_balance(out, _uniform(rng, cfg.white_balance_shift))
    out = vignette(out, _uniform(rng, cfg.vignette_strength))
    out = gaussian_blur(out, _uniform(rng, cfg.blur_sigma))
    out = out + rng.normal(0.0, _uniform(rng, cfg.gaussian_noise_sigma), out.shape)
    out = np.clip(out, 0, MAX_UINT8)
    return jpeg_cycle(out, int(rng.integers(cfg.jpeg_quality[0], cfg.jpeg_quality[1] + 1)))


def luminance_histogram(image: np.ndarray, bins: int = 64) -> np.ndarray:
    """Normalised luminance histogram, the check E3-T9 is graded on."""
    luma = image.astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    hist, _ = np.histogram(luma, bins=bins, range=(0.0, 255.0))
    total = hist.sum()
    return hist.astype(np.float32) / total if total else hist.astype(np.float32)


def histogram_distance(first: np.ndarray, second: np.ndarray) -> float:
    """Total variation distance between two normalised histograms, 0 identical, 1 disjoint."""
    return float(np.abs(first - second).sum() / 2.0)
