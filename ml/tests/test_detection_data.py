"""E4-T5: augmentation moves every annotation together, and priors get assigned."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import torch
from PIL import Image

from facepipe.core.registry import DATASETS
from facepipe.tasks.detection.data import (
    FLIP_INDEX,
    Sample,
    WiderFaceDataset,
    assign_priors,
    build_targets,
    collate,
    horizontal_flip,
    letterbox,
)
from facepipe.tasks.detection.student import STRIDES, feature_sizes, pyramid_priors

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
