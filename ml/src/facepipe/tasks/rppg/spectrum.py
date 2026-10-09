"""Pulse rate and how clearly it stands out, from one window of pulse signal."""

from __future__ import annotations

import numpy as np

# Half-width of a Hann window's main lobe, in units of 1/T.
HANN_LOBE = 2.0


def power_spectrum(signal: np.ndarray, fs: float, nfft: int) -> tuple[np.ndarray, np.ndarray]:
    """Hann-windowed power on a grid zero-padded to `nfft`, no shorter than the signal."""
    size = max(nfft, len(signal))
    spectrum = np.fft.rfft((signal - signal.mean()) * np.hanning(len(signal)), n=size)
    return np.fft.rfftfreq(size, 1.0 / fs), np.abs(spectrum) ** 2


def peak_halfwidth(seconds: float, floor_hz: float) -> float:
    """Room counted as the peak, never narrower than the main lobe a short window smears it into."""
    return max(floor_hz, HANN_LOBE / seconds)


def refined_peak(freqs: np.ndarray, power: np.ndarray, index: int) -> float:
    """The peak between bins, from a parabola through the log power of its neighbours."""
    if index <= 0 or index >= len(power) - 1:
        return float(freqs[index])
    left, centre, right = np.log(np.maximum(power[index - 1 : index + 2], 1e-300))
    curve = left - 2.0 * centre + right
    shift = 0.5 * (left - right) / curve if curve < 0 else 0.0
    return float(freqs[index] + shift * (freqs[1] - freqs[0]))


def peak_snr(
    freqs: np.ndarray, power: np.ndarray, band: tuple[float, float], halfwidth: float
) -> tuple[float, float]:
    """Beats per minute of the strongest in-band peak, and its SNR in dB.

    de Haan & Jeanne 2013 with the peak standing in for the unknown true rate: power
    within `halfwidth` of the peak and of its second harmonic, over the rest of the band.
    """
    inside = (freqs >= band[0]) & (freqs <= band[1])
    if not inside.any() or power[inside].sum() <= 0:
        return float("nan"), float("nan")
    index = int(np.flatnonzero(inside)[np.argmax(power[inside])])
    peak = refined_peak(freqs, power, index)
    near = (np.abs(freqs - peak) <= halfwidth) | (np.abs(freqs - 2.0 * peak) <= halfwidth)
    signal = power[inside & near].sum()
    noise = power[inside & ~near].sum()
    if noise <= 0:
        return peak * 60.0, float("inf")
    return peak * 60.0, float(10.0 * np.log10(signal / noise))
