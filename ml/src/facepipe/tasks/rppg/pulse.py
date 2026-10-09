"""Pulse signal from per-frame mean colour: GREEN, CHROM and POS (KEHOACH 3).

Written from the papers (Verkruysse 2008, de Haan 2013, Wang 2017) with nothing but
means, ratios and one biquad run both ways, operations esp-dsp offers, so a C port can
be checked against this file with golden vectors.
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


def butter_bandpass(fs: float, band: tuple[float, float]) -> tuple[np.ndarray, np.ndarray]:
    """First-order Butterworth band-pass as one biquad, prewarped as scipy.signal.butter does.

    Its gentle edges are the point: a brick-wall cut keeps motion and breathing near the
    low edge at full strength, and that peak beats the pulse (measurements/rppg §1).
    """
    k = 2.0 * fs
    low, high = (k * np.tan(np.pi * edge / fs) for edge in band)
    width, centre2 = high - low, low * high
    a0 = k * k + width * k + centre2
    b = np.array([width * k, 0.0, -width * k]) / a0
    a = np.array([1.0, (2.0 * centre2 - 2.0 * k * k) / a0, (k * k - width * k + centre2) / a0])
    return b, a


def biquad(
    b: np.ndarray, a: np.ndarray, signal: np.ndarray, state: tuple[float, float]
) -> np.ndarray:
    """Direct form II transposed, the structure of esp-dsp's dsps_biquad."""
    out = np.empty(len(signal))
    z1, z2 = state
    for index, value in enumerate(signal):
        y = b[0] * value + z1
        z1 = b[1] * value - a[1] * y + z2
        z2 = b[2] * value - a[2] * y
        out[index] = y
    return out


def filtfilt(b: np.ndarray, a: np.ndarray, signal: np.ndarray) -> np.ndarray:
    """Forward then backward, padded by odd reflection and started at steady state, as scipy."""
    pad = min(9, len(signal) - 1)
    head = 2.0 * signal[0] - signal[pad:0:-1]
    tail = 2.0 * signal[-1] - signal[-2 : -pad - 2 : -1]
    padded = np.concatenate([head, signal, tail])
    lead = b[1:] - a[1:] * b[0]
    z1 = (lead[0] + lead[1]) / (1.0 + a[1] + a[2])
    steady = (z1, lead[1] - a[2] * z1)
    forward = biquad(b, a, padded, (steady[0] * padded[0], steady[1] * padded[0]))
    backward = biquad(b, a, forward[::-1], (steady[0] * forward[-1], steady[1] * forward[-1]))
    return backward[::-1][pad : len(padded) - pad]


def bandpass(signal: np.ndarray, fs: float, band: tuple[float, float]) -> np.ndarray:
    b, a = butter_bandpass(fs, band)
    return filtfilt(b, a, signal)


def normalised(rgb: np.ndarray) -> np.ndarray:
    return rgb / rgb.mean(axis=0, keepdims=True)


def green(rgb: np.ndarray, fs: float, band: tuple[float, float]) -> np.ndarray:
    return bandpass(normalised(rgb)[:, 1] - 1.0, fs, band)


def chrom(rgb: np.ndarray, fs: float, band: tuple[float, float]) -> np.ndarray:
    """de Haan & Jeanne 2013: two chrominance signals, mixed to cancel specular change."""
    n = normalised(rgb)
    x = bandpass(3.0 * n[:, 0] - 2.0 * n[:, 1], fs, band)
    y = bandpass(1.5 * n[:, 0] + n[:, 1] - 1.5 * n[:, 2], fs, band)
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
    return bandpass(pulse, fs, band)


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
