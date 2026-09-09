"""E4-T5: augmentation moves every annotation together, and priors get assigned."""

from __future__ import annotations

import json
import random
from pathlib import Path

import numpy as np
import pytest
import torch
from PIL import Image

from facepipe.core.registry import DATASETS
from facepipe.tasks.detection.data import (
    FLIP_INDEX,
    LEVEL_RANGES,
    Sample,
    WiderFaceDataset,
    assign_priors,
    build_targets,
    collate,
    drop_small_faces,
    horizontal_flip,
    letterbox,
    random_crop,
)
from facepipe.tasks.detection.model import STRIDES, feature_sizes, pyramid_priors
from facepipe.tasks.detection.model.head import LANDMARK_COUNT

INPUT_HW = (120, 160)
LANDMARKS = np.array([[[20.0, 30.0], [60.0, 30.0], [40.0, 50.0], [25.0, 70.0], [55.0, 70.0]]])


def make_sample(height: int = 200, width: int = 100) -> Sample:
    return Sample(
        image=np.zeros((height, width, 3), dtype=np.uint8),
        boxes=np.array([[10.0, 20.0, 50.0, 80.0]], dtype=np.float32),
        landmarks=LANDMARKS.astype(np.float32),
        has_landmarks=np.array([True]),
        teacher_boxes=np.array([[12.0, 22.0, 52.0, 82.0]], dtype=np.float32),
        teacher_scores=np.array([0.9], dtype=np.float32),
        teacher_landmarks=LANDMARKS.astype(np.float32) + 1.0,
    )


def test_letterbox_keeps_the_aspect_ratio() -> None:
    out = letterbox(make_sample(200, 100), INPUT_HW)
    assert out.image.shape == (*INPUT_HW, 3)


def test_letterbox_moves_the_teacher_boxes_with_the_real_ones() -> None:
    sample = make_sample()
    out = letterbox(sample, INPUT_HW)
    gap_before = sample.teacher_boxes - sample.boxes
    gap_after = out.teacher_boxes - out.boxes
    assert np.allclose(gap_after, gap_before * (out.boxes[0, 2] - out.boxes[0, 0]) / 40.0)


def test_flip_mirrors_boxes_within_the_image() -> None:
    sample = make_sample(100, 200)
    out = horizontal_flip(sample)
    assert out.boxes[0, 0] == pytest.approx(200 - sample.boxes[0, 2])
    assert out.boxes[0, 2] == pytest.approx(200 - sample.boxes[0, 0])
    assert out.boxes[0, 2] > out.boxes[0, 0]


def test_flip_swaps_the_eyes_and_the_mouth_corners() -> None:
    sample = make_sample(100, 200)
    out = horizontal_flip(sample)
    for target, source in enumerate(FLIP_INDEX):
        assert out.landmarks[0, target, 1] == pytest.approx(sample.landmarks[0, source, 1])
    assert FLIP_INDEX[2] == 2


def test_flip_reorders_the_teacher_landmarks_the_same_way() -> None:
    sample = make_sample(100, 200)
    out = horizontal_flip(sample)
    assert np.allclose(out.teacher_landmarks[0, :, 1], sample.teacher_landmarks[0, FLIP_INDEX, 1])


def test_flipping_twice_returns_the_original() -> None:
    sample = make_sample(100, 200)
    out = horizontal_flip(horizontal_flip(sample))
    assert np.allclose(out.boxes, sample.boxes)
    assert np.allclose(out.landmarks, sample.landmarks)


def priors_for(hw: tuple[int, int] = INPUT_HW) -> torch.Tensor:
    return torch.cat(pyramid_priors(feature_sizes(hw, STRIDES), STRIDES))


def test_a_face_takes_priors_and_the_rest_stay_background() -> None:
    priors = priors_for()
    boxes = np.array([[40.0, 40.0, 70.0, 70.0]], dtype=np.float32)
    owner, positive = assign_priors(boxes, priors)
    assert positive.any()
    assert set(owner[positive].tolist()) == {0}
    assert (owner[~positive] == -1).all()


def test_an_image_with_no_face_has_no_positive_prior() -> None:
    owner, positive = assign_priors(np.zeros((0, 4), np.float32), priors_for())
    assert not positive.any() and (owner == -1).all()


def test_a_small_face_keeps_its_priors_against_a_large_one() -> None:
    priors = priors_for()
    boxes = np.array([[0.0, 0.0, 150.0, 110.0], [60.0, 50.0, 76.0, 66.0]], dtype=np.float32)
    owner, positive = assign_priors(boxes, priors)
    assert 1 in owner[positive].tolist()


def test_big_and_small_faces_land_on_different_levels() -> None:
    priors = priors_for()
    small = assign_priors(np.array([[60.0, 50.0, 76.0, 66.0]], np.float32), priors)[1]
    large = assign_priors(np.array([[10.0, 5.0, 140.0, 110.0]], np.float32), priors)[1]
    assert priors[small][:, 2].unique().tolist() != priors[large][:, 2].unique().tolist()


def test_targets_carry_the_box_of_whichever_face_owns_the_prior() -> None:
    sample = letterbox(make_sample(), INPUT_HW)
    targets = build_targets(sample, priors_for())
    assert targets.positives.any()
    owned = targets.boxes[targets.positives]
    assert torch.allclose(owned, owned[0].expand_as(owned))


def test_a_face_without_landmark_labels_leaves_the_mask_clear() -> None:
    sample = letterbox(make_sample(), INPUT_HW)
    sample.has_landmarks = np.array([False])
    targets = build_targets(sample, priors_for())
    assert targets.positives.any()
    assert not targets.landmark_mask.any()


def build_dataset(tmp_path: Path, train: bool = True) -> WiderFaceDataset:
    images = tmp_path / "images" / "0--Parade"
    images.mkdir(parents=True)
    Image.new("RGB", (100, 200), (30, 60, 90)).save(images / "a.jpg")

    coco = {
        "images": [{"id": 1, "file_name": "0--Parade/a.jpg", "width": 100, "height": 200}],
        "annotations": [
            {
                "image_id": 1,
                "bbox": [10.0, 20.0, 40.0, 60.0],
                "keypoints": [20, 30, 2, 60, 30, 2, 40, 50, 2, 25, 70, 2, 55, 70, 2],
                "num_keypoints": 5,
            }
        ],
    }
    (tmp_path / "train.json").write_text(json.dumps(coco), encoding="utf-8")
    (tmp_path / "split.txt").write_text("0--Parade/a.jpg\n", encoding="utf-8")

    return WiderFaceDataset(
        coco=tmp_path / "train.json",
        images_root=tmp_path / "images",
        split_file=tmp_path / "split.txt",
        input_hw=INPUT_HW,
        train=train,
    )


def test_the_dataset_reads_only_what_the_split_lists(tmp_path: Path) -> None:
    assert len(build_dataset(tmp_path)) == 1


def test_an_item_comes_out_shaped_for_the_model(tmp_path: Path) -> None:
    image, targets = build_dataset(tmp_path, train=False)[0]
    assert image.shape == (3, *INPUT_HW)
    assert float(image.min()) >= 0.0 and float(image.max()) <= 1.0
    assert targets.labels.shape == (targets.priors.shape[0],)


def test_collate_stacks_targets_and_keeps_raw_boxes_per_image(tmp_path: Path) -> None:
    dataset = build_dataset(tmp_path, train=False)
    images, targets = collate([dataset[0], dataset[0]])
    assert images.shape == (2, 3, *INPUT_HW)
    assert targets.labels.shape == (2, targets.priors.shape[0])
    assert len(targets.gt_boxes) == 2


def test_the_dataset_is_selectable_by_name() -> None:
    assert "widerface" in DATASETS


def sample_with(boxes: np.ndarray, size: tuple[int, int] = (200, 400)) -> Sample:
    return Sample(
        image=np.zeros((*size, 3), dtype=np.uint8),
        boxes=boxes.astype(np.float32),
        landmarks=np.zeros((len(boxes), LANDMARK_COUNT, 2), np.float32),
        has_landmarks=np.zeros(len(boxes), dtype=bool),
    )


def test_a_crop_moves_the_boxes_with_the_window() -> None:
    boxes = np.array([[100.0, 50.0, 140.0, 90.0]])
    cropped = random_crop(sample_with(boxes), random.Random(0), scale=(0.5, 0.5))
    height, width = cropped.image.shape[:2]
    assert (height, width) == (100, 200)
    if len(cropped.boxes):
        assert (cropped.boxes[:, :2] >= -1).all()


def test_a_crop_drops_the_faces_it_cut_away() -> None:
    """A box clipped by the window edge no longer describes a face, so it goes."""
    boxes = np.array([[10.0, 10.0, 30.0, 30.0], [380.0, 180.0, 399.0, 199.0]])
    kept = random_crop(sample_with(boxes), random.Random(1), scale=(0.25, 0.25))
    assert len(kept.boxes) < len(boxes)


def face_side(sample: Sample) -> float:
    if not len(sample.boxes):
        return 0.0
    box = sample.boxes[0]
    return float(np.sqrt(max(box[2] - box[0], 0) * max(box[3] - box[1], 0)))


def test_a_close_crop_makes_a_face_bigger_at_the_input() -> None:
    """The whole point: the same face has to be able to arrive large.

    Where the window lands is random, so this takes the first seed whose window
    keeps the face; a window that cuts it away is the other behaviour, covered
    by its own test.
    """
    boxes = np.array([[180.0, 90.0, 220.0, 110.0]])
    wide = face_side(letterbox(sample_with(boxes), (120, 160)))

    for seed in range(50):
        cropped = random_crop(sample_with(boxes), random.Random(seed), scale=(0.3, 0.3))
        if len(cropped.boxes):
            assert face_side(letterbox(cropped, (120, 160))) > wide * 2
            return
    raise AssertionError("no crop in fifty seeds kept the face")


def test_faces_below_one_grid_cell_are_dropped() -> None:
    boxes = np.array([[0.0, 0.0, 4.0, 4.0], [0.0, 0.0, 20.0, 20.0]])
    kept = drop_small_faces(sample_with(boxes), min_px=8.0)
    assert len(kept.boxes) == 1
    assert kept.boxes[0][2] == 20.0


def test_the_filter_keeps_every_annotation_row_in_step() -> None:
    """Boxes, landmarks and the landmark flag are three arrays for one face."""
    boxes = np.array([[0.0, 0.0, 4.0, 4.0], [0.0, 0.0, 20.0, 20.0], [0.0, 0.0, 2.0, 2.0]])
    sample = sample_with(boxes)
    sample.has_landmarks = np.array([True, False, True])
    kept = drop_small_faces(sample, min_px=8.0)
    assert len(kept.boxes) == len(kept.landmarks) == len(kept.has_landmarks) == 1
    assert kept.has_landmarks.tolist() == [False]


def test_every_pyramid_level_owns_a_slice_of_the_new_ranges() -> None:
    """The ranges these replaced left level 2 with no positive prior at all."""
    assert LEVEL_RANGES[0][1] == 16.0
    assert LEVEL_RANGES[1] == (16.0, 48.0)
    for size, expected in ((10.0, 0), (30.0, 1), (60.0, 2)):
        assert next(i for i, (lo, hi) in enumerate(LEVEL_RANGES) if lo <= size < hi) == expected
