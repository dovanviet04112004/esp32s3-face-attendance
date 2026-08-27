"""E3-T9: the OV5640 sensor simulation is deterministic and moves the histogram."""

from __future__ import annotations

import numpy as np
import pytest

from facepipe.data.transforms.sensor_sim import (
    SensorSimConfig,
    histogram_distance,
    luminance_histogram,
    simulate,
    vignette,
    white_balance,
)


@pytest.fixture
def clean_image() -> np.ndarray:
    rng = np.random.default_rng(0)
    base = np.linspace(40, 210, 64, dtype=np.float32)
    image = np.repeat(base[None, :], 64, axis=0)
    noise = rng.normal(0, 4, (64, 64))
    return np.clip(np.stack([image + noise] * 3, axis=-1), 0, 255).astype(np.uint8)


def test_same_seed_gives_the_same_pixels(clean_image) -> None:
    first = simulate(clean_image, seed=11)
    second = simulate(clean_image, seed=11)
    assert np.array_equal(first, second)


def test_different_seed_gives_different_pixels(clean_image) -> None:
    assert not np.array_equal(simulate(clean_image, seed=1), simulate(clean_image, seed=2))


def test_output_keeps_shape_and_dtype(clean_image) -> None:
    out = simulate(clean_image, seed=3)
    assert out.shape == clean_image.shape
    assert out.dtype == np.uint8


def test_simulation_moves_the_histogram(clean_image) -> None:
    before = luminance_histogram(clean_image)
    after = luminance_histogram(simulate(clean_image, seed=5))
    assert histogram_distance(before, after) > 0.02


def test_histogram_distance_is_zero_for_identical_images(clean_image) -> None:
    hist = luminance_histogram(clean_image)
    assert histogram_distance(hist, hist) == pytest.approx(0.0)


def test_histogram_is_normalised(clean_image) -> None:
    assert luminance_histogram(clean_image).sum() == pytest.approx(1.0)


def test_probability_zero_leaves_the_image_alone(clean_image) -> None:
    config = SensorSimConfig(probability=0.0)
    assert np.array_equal(simulate(clean_image, seed=9, config=config), clean_image)


def test_vignette_darkens_corners_more_than_centre(clean_image) -> None:
    out = vignette(clean_image.astype(np.float32), 0.35)
    centre = out[30:34, 30:34].mean()
    corner = out[0:4, 0:4].mean()
    reference_centre = clean_image[30:34, 30:34].mean()
    reference_corner = clean_image[0:4, 0:4].mean()
    assert corner / reference_corner < centre / reference_centre


def test_white_balance_moves_red_and_blue_in_opposite_directions(clean_image) -> None:
    out = white_balance(clean_image.astype(np.float32), 0.08)
    assert out[..., 0].mean() > clean_image[..., 0].mean()
    assert out[..., 2].mean() < clean_image[..., 2].mean()


def test_strong_settings_degrade_more_than_mild_ones(clean_image) -> None:
    mild = SensorSimConfig(
        jpeg_quality=(90, 90),
        gaussian_noise_sigma=(0.0, 0.0),
        blur_sigma=(0.0, 0.0),
        brightness_gain=(1.0, 1.0),
        white_balance_shift=(0.0, 0.0),
        vignette_strength=(0.0, 0.0),
        probability=1.0,
    )
    harsh = SensorSimConfig(
        jpeg_quality=(20, 20),
        gaussian_noise_sigma=(12.0, 12.0),
        blur_sigma=(1.5, 1.5),
        brightness_gain=(0.5, 0.5),
        white_balance_shift=(0.1, 0.1),
        vignette_strength=(0.4, 0.4),
        probability=1.0,
    )
    reference = luminance_histogram(clean_image)
    mild_distance = histogram_distance(
        reference, luminance_histogram(simulate(clean_image, 4, mild))
    )
    harsh_distance = histogram_distance(
        reference, luminance_histogram(simulate(clean_image, 4, harsh))
    )
    assert harsh_distance > mild_distance
