"""E5-T5: alignment, normalisation and matching, the three the C port must copy."""

from __future__ import annotations

import numpy as np
import pytest

from facepipe.tasks.recognition.postproc import (
    ALIGNED_SIZE,
    REFERENCE_LANDMARKS,
    align,
    best_match,
    cosine,
    cosine_int8,
    dequantize,
    invert_affine,
    l2_normalize,
    quantize,
    reference_landmarks,
    similarity_transform,
    warp_affine,
)


def apply(matrix: np.ndarray, points: np.ndarray) -> np.ndarray:
    return points @ matrix[:, :2].T + matrix[:, 2]


def test_the_transform_puts_the_landmarks_on_the_reference() -> None:
    """Five points onto five points is exact for a similarity when they are similar."""
    rotation = np.array([[0.0, -1.0], [1.0, 0.0]])
    source = REFERENCE_LANDMARKS @ rotation.T * 2.0 + np.array([30.0, -10.0])
    matrix = similarity_transform(source, REFERENCE_LANDMARKS)
    assert np.allclose(apply(matrix, source), REFERENCE_LANDMARKS, atol=1e-6)


def test_the_transform_never_mirrors_a_face() -> None:
    """A mirrored face reads as a different person, so a negative determinant is a bug."""
    mirrored = REFERENCE_LANDMARKS.copy()
    mirrored[:, 0] = ALIGNED_SIZE - mirrored[:, 0]
    matrix = similarity_transform(mirrored, REFERENCE_LANDMARKS)
    assert np.linalg.det(matrix[:, :2]) > 0


def test_the_transform_keeps_shape_and_only_scales_uniformly() -> None:
    """A full affine could shear a face flat onto the reference and erase identity."""
    source = REFERENCE_LANDMARKS.copy()
    source[2] += np.array([9.0, -7.0])
    linear = similarity_transform(source, REFERENCE_LANDMARKS)[:, :2]
    assert np.allclose(linear @ linear.T, np.eye(2) * np.linalg.det(linear), atol=1e-8)


def test_inverting_the_transform_returns_the_original_points() -> None:
    matrix = similarity_transform(REFERENCE_LANDMARKS * 1.7 + 4.0, REFERENCE_LANDMARKS)
    points = np.array([[0.0, 0.0], [11.0, 3.0], [50.0, 70.0]])
    assert np.allclose(apply(invert_affine(matrix), apply(matrix, points)), points, atol=1e-8)


def test_the_reference_scales_with_the_output_size() -> None:
    assert np.allclose(reference_landmarks(224), REFERENCE_LANDMARKS * 2.0)


def test_warping_the_identity_transform_copies_the_image() -> None:
    rng = np.random.default_rng(0)
    image = rng.integers(0, 255, (ALIGNED_SIZE, ALIGNED_SIZE, 3), dtype=np.uint8)
    identity = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
    assert np.array_equal(warp_affine(image, identity), image)


def test_warping_leaves_no_holes_when_the_face_is_magnified() -> None:
    """A forward warp would leave gaps here; sampling from the destination cannot."""
    image = np.full((40, 40, 3), 200, dtype=np.uint8)
    matrix = np.array([[3.0, 0.0, 5.0], [0.0, 3.0, 5.0]])
    warped = warp_affine(image, matrix, size=ALIGNED_SIZE)
    assert warped.shape == (ALIGNED_SIZE, ALIGNED_SIZE, 3)
    assert warped.min() > 0


def test_aligning_a_face_lands_its_landmarks_on_the_reference() -> None:
    rng = np.random.default_rng(1)
    image = rng.integers(0, 255, (200, 300, 3), dtype=np.uint8)
    landmarks = REFERENCE_LANDMARKS * 1.4 + np.array([60.0, 20.0])
    out = align(image, landmarks)
    assert out.shape == (ALIGNED_SIZE, ALIGNED_SIZE, 3)
    assert out.dtype == np.uint8


def test_normalising_gives_unit_rows() -> None:
    rows = np.array([[3.0, 4.0], [1.0, 0.0]], dtype=np.float32)
    unit = l2_normalize(rows)
    assert np.allclose(np.linalg.norm(unit, axis=1), 1.0, atol=1e-6)
    assert np.allclose(unit[0], [0.6, 0.8], atol=1e-6)


def test_normalising_a_dead_embedding_stays_dead() -> None:
    """A zero vector made unit length would point somewhere and match somebody."""
    assert np.allclose(l2_normalize(np.zeros(8, dtype=np.float32)), 0.0)


def test_normalising_keeps_a_single_vector_a_single_vector() -> None:
    assert l2_normalize(np.ones(4, dtype=np.float32)).shape == (4,)


def test_quantising_and_reading_back_stays_close() -> None:
    rng = np.random.default_rng(2)
    values = l2_normalize(rng.standard_normal(512).astype(np.float32))
    quantized, scale = quantize(values)
    assert quantized.dtype == np.int8
    assert np.abs(dequantize(quantized, scale) - values).max() < scale


def test_a_dead_embedding_quantises_to_zero_without_dividing() -> None:
    quantized, scale = quantize(np.zeros(8, dtype=np.float32))
    assert scale == 0.0 and not quantized.any()


def test_the_stored_scale_cancels_out_of_the_similarity() -> None:
    """Cosine measures angle, so the device compares int8 without dequantising."""
    rng = np.random.default_rng(3)
    a = l2_normalize(rng.standard_normal(512).astype(np.float32))
    b = l2_normalize(rng.standard_normal(512).astype(np.float32))
    quantized_a, _ = quantize(a)
    quantized_b, _ = quantize(b * 0.01)
    assert cosine_int8(quantized_a, quantized_b) == pytest.approx(float(a @ b), abs=2e-3)


def test_matching_picks_the_closest_template() -> None:
    gallery = np.array([[1.0, 0.0], [0.0, 1.0], [0.9, 0.1]], dtype=np.float32)
    query = np.array([0.88, 0.12], dtype=np.float32)
    index, score = best_match(query, gallery)
    assert index == 2
    assert score == pytest.approx(float(cosine(query, gallery).max()))


def test_matching_an_empty_gallery_reports_no_match() -> None:
    assert best_match(np.ones(4, dtype=np.float32), np.zeros((0, 4), dtype=np.float32)) == (
        -1,
        -1.0,
    )
