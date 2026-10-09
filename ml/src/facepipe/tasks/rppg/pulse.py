"""Pulse signal from per-frame mean colour: GREEN, CHROM and POS (KEHOACH 3).

Written from the papers (Verkruysse 2008, de Haan 2013, Wang 2017) with nothing but
means, ratios and a real FFT, the operations esp-dsp offers, so a C port can be
checked against this file with golden vectors.
"""

from __future__ import annotations

import numpy as np

# POS projection plane, Wang et al. 2017 eq. (6).
POS_PLANE = np.array([[0.0, 1.0, -1.0], [-2.0, 1.0, 1.0]])


def uniform(t: np.ndarray, rgb: np.ndarray, fs: float) -> np.ndarray:
    """An (n, 3) series of uneven times resampled onto a grid at `fs` from its first sample."""
    t = np.asarray(t, dtype=np.float64)
    grid = t[0] + np.arange(int(np.floor((t[-1] - t[0]) * fs)) + 1) / fs
    return np.stack([np.interp(grid, t, rgb[:, channel]) for channel in range(3)], axis=1)


def bandlimit(signal: np.ndarray, fs: float, band: tuple[float, float]) -> np.ndarray:
    spectrum = np.fft.rfft(signal - signal.mean())
    freqs = np.fft.rfftfreq(len(signal), 1.0 / fs)
    spectrum[(freqs < band[0]) | (freqs > band[1])] = 0
    return np.fft.irfft(spectrum, n=len(signal))


def normalised(rgb: np.ndarray) -> np.ndarray:
    return rgb / rgb.mean(axis=0, keepdims=True)


def green(rgb: np.ndarray, fs: float, band: tuple[float, float]) -> np.ndarray:
    return bandlimit(normalised(rgb)[:, 1] - 1.0, fs, band)


def chrom(rgb: np.ndarray, fs: float, band: tuple[float, float]) -> np.ndarray:
    """de Haan & Jeanne 2013: two chrominance signals, mixed to cancel specular change."""
    n = normalised(rgb)
    x = bandlimit(3.0 * n[:, 0] - 2.0 * n[:, 1], fs, band)
    y = bandlimit(1.5 * n[:, 0] + n[:, 1] - 1.5 * n[:, 2], fs, band)
    spread = y.std()
    return x - (x.std() / spread if spread > 0 else 0.0) * y


def pos(rgb: np.ndarray, fs: float, band: tuple[float, float], window_s: float) -> np.ndarray:
    """Wang et al. 2017: project on the plane orthogonal to skin tone, overlap-add per window."""
    length = max(round(window_s * fs), 2)
    pulse = np.zeros(len(rgb))
    for start in range(len(rgb) - length + 1):
        chunk = normalised(rgb[start : start + length]).T
        s = POS_PLANE @ chunk
        spread = s[1].std()
        h = s[0] + (s[0].std() / spread if spread > 0 else 0.0) * s[1]
        pulse[start : start + length] += h - h.mean()
    return bandlimit(pulse, fs, band)


def pulse_of(
    method: str, rgb: np.ndarray, fs: float, band: tuple[float, float], window_s: float
) -> np.ndarray:
    if method == "green":
        return green(rgb, fs, band)
    if method == "chrom":
        return chrom(rgb, fs, band)
    if method == "pos":
        return pos(rgb, fs, band, window_s)
    raise ValueError(f"unknown rPPG method {method!r}")
