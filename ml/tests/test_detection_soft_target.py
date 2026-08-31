"""E4-T13: the teacher's detections arriving on the student's own priors."""

from __future__ import annotations

import numpy as np
import pytest
import torch

from facepipe.core.registry import TEACHERS
from facepipe.tasks.detection.data import (
    TEACHER_BACKGROUND_LOGIT,
    Sample,
    build_targets,
    collate,
    teacher_targets,
)
from facepipe.tasks.detection.losses.kd_feature_fgd import FeatureFGDLoss
from facepipe.tasks.detection.postproc.decode import (
    bbox_decode,
    flatten_levels,
    kps_decode,
    unflatten_levels,
)
from facepipe.tasks.detection.student import STRIDES, feature_sizes, pyramid_priors
from facepipe.tasks.detection.student.head import LANDMARK_COUNT
from facepipe.tasks.detection.teacher.export_soft_target import CachedHeadOutput
from facepipe.tasks.detection.teacher.yolo26_pose_wrapper import (
    PriorAssignedTeacher,
    TeacherDetections,
)

INPUT_HW = (120, 160)
TEACHER_BOX = np.array([[40.0, 40.0, 72.0, 72.0]], dtype=np.float32)
TEACHER_KPS = np.array(
    [[[48.0, 50.0], [64.0, 50.0], [56.0, 58.0], [50.0, 66.0], [62.0, 66.0]]], dtype=np.float32
)


def priors_for(hw: tuple[int, int] = INPUT_HW) -> torch.Tensor:
    return torch.cat(pyramid_priors(feature_sizes(hw, STRIDES), STRIDES))


def sample_with_teacher(score: float = 0.9) -> Sample:
    return Sample(
        image=np.zeros((*INPUT_HW, 3), dtype=np.uint8),
        boxes=TEACHER_BOX.copy(),
        landmarks=TEACHER_KPS.copy(),
        has_landmarks=np.array([True]),
        teacher_boxes=TEACHER_BOX.copy(),
        teacher_scores=np.array([score], dtype=np.float32),
        teacher_landmarks=TEACHER_KPS.copy(),
    )


def test_a_prior_no_teacher_box_claims_sits_at_background() -> None:
    priors = priors_for()
    cls, _, _ = teacher_targets(sample_with_teacher(), priors)
    claimed = cls.squeeze(-1) > TEACHER_BACKGROUND_LOGIT
    assert claimed.any()
    background = cls.squeeze(-1)[~claimed]
    assert torch.allclose(background, torch.full_like(background, TEACHER_BACKGROUND_LOGIT))


def test_the_score_survives_the_trip_through_the_logit() -> None:
    """The KL term sigmoids these back, so the teacher's confidence has to return."""
    priors = priors_for()
    cls, _, _ = teacher_targets(sample_with_teacher(score=0.73), priors)
    claimed = cls.squeeze(-1) > TEACHER_BACKGROUND_LOGIT
    assert cls.squeeze(-1)[claimed].sigmoid().allclose(torch.full((int(claimed.sum()),), 0.73))


def test_the_encoded_box_decodes_back_to_the_teachers_pixels() -> None:
    """The whole point of re-encoding: the teacher regresses from its own priors,
    so only the pixel box carries over and it must land back where it was."""
    priors = priors_for()
    cls, bbox, _ = teacher_targets(sample_with_teacher(), priors)
    claimed = cls.squeeze(-1) > TEACHER_BACKGROUND_LOGIT
    decoded = bbox_decode(priors[claimed], bbox[claimed])
    expected = torch.as_tensor(TEACHER_BOX).expand_as(decoded)
    assert torch.allclose(decoded, expected, atol=1e-3)


def test_the_encoded_landmarks_decode_back_to_the_teachers_pixels() -> None:
    priors = priors_for()
    cls, _, kps = teacher_targets(sample_with_teacher(), priors)
    claimed = cls.squeeze(-1) > TEACHER_BACKGROUND_LOGIT
    decoded = kps_decode(priors[claimed], kps[claimed])
    expected = torch.as_tensor(TEACHER_KPS).reshape(1, -1).expand_as(decoded)
    assert torch.allclose(decoded, expected, atol=1e-3)


def test_a_sample_with_no_teacher_rows_carries_no_teacher_targets() -> None:
    """The baseline arm runs the same loader, and must not pay for what it skips."""
    sample = sample_with_teacher()
    sample.teacher_boxes = np.zeros((0, 4), np.float32)
    sample.teacher_scores = np.zeros(0, np.float32)
    sample.teacher_landmarks = np.zeros((0, LANDMARK_COUNT, 2), np.float32)
    targets = build_targets(sample, priors_for())
    assert targets.teacher_cls is None
    assert targets.teacher_bbox is None and targets.teacher_kps is None


def test_the_batch_stacks_the_teacher_rows() -> None:
    priors = priors_for()
    item = (torch.zeros(3, *INPUT_HW), build_targets(sample_with_teacher(), priors))
    _, merged = collate([item, item])
    assert merged.teacher_cls.shape == (2, priors.shape[0], 1)
    assert merged.teacher_bbox.shape == (2, priors.shape[0], 4)
    assert merged.teacher_kps.shape == (2, priors.shape[0], LANDMARK_COUNT * 2)


def test_a_batch_missing_the_teacher_on_one_sample_stacks_nothing() -> None:
    priors = priors_for()
    bare = sample_with_teacher()
    bare.teacher_scores = np.zeros(0, np.float32)
    bare.teacher_boxes = np.zeros((0, 4), np.float32)
    bare.teacher_landmarks = np.zeros((0, LANDMARK_COUNT, 2), np.float32)
    items = [
        (torch.zeros(3, *INPUT_HW), build_targets(sample_with_teacher(), priors)),
        (torch.zeros(3, *INPUT_HW), build_targets(bare, priors)),
    ]
    assert collate(items)[1].teacher_cls is None


def test_unflattening_is_the_inverse_of_flattening() -> None:
    sizes = feature_sizes(INPUT_HW, STRIDES)
    total = sum(h * w for h, w in sizes)
    flat = torch.randn(2, total, 4)
    assert torch.allclose(flatten_levels(unflatten_levels(flat, sizes)), flat)


def test_rows_that_do_not_fill_the_levels_are_rejected() -> None:
    sizes = feature_sizes(INPUT_HW, STRIDES)
    with pytest.raises(ValueError):
        unflatten_levels(torch.randn(1, 7, 4), sizes)


def test_the_cached_teacher_is_selectable_by_name() -> None:
    assert "cached_head_output" in TEACHERS


class FakeDetector(torch.nn.Module):
    """Answers with one fixed box, in whatever frame it was handed."""

    def __init__(self, scale: float) -> None:
        super().__init__()
        self.scale = scale
        self.saw_hw: tuple[int, int] | None = None

    def forward(self, images: torch.Tensor) -> TeacherDetections:
        self.saw_hw = tuple(images.shape[-2:])
        count = images.shape[0]
        return TeacherDetections(
            boxes=[torch.as_tensor(TEACHER_BOX) * self.scale] * count,
            scores=[torch.tensor([0.9])] * count,
            keypoints=[torch.as_tensor(TEACHER_KPS) * self.scale] * count,
        )


def test_the_online_teacher_shows_the_detector_the_upscaled_frame() -> None:
    """FGD compares feature maps, so the detector has to see the student's own
    frame rather than the original, only larger."""
    detector = FakeDetector(scale=4.0)
    teacher = PriorAssignedTeacher(upscale=4, input_hw=INPUT_HW, detector=detector)
    teacher((torch.zeros(2, 3, *INPUT_HW), priors_for()))
    assert detector.saw_hw == (INPUT_HW[0] * 4, INPUT_HW[1] * 4)


def test_the_online_teacher_brings_boxes_back_to_the_student_frame() -> None:
    """Detections come out in the upscaled frame and must land on the student's."""
    teacher = PriorAssignedTeacher(upscale=4, input_hw=INPUT_HW, detector=FakeDetector(scale=4.0))
    priors = priors_for()
    out = teacher((torch.zeros(1, 3, *INPUT_HW), priors))

    cls, bbox = flatten_levels(out.cls)[0], flatten_levels(out.bbox)[0]
    claimed = cls.squeeze(-1) > TEACHER_BACKGROUND_LOGIT
    assert claimed.any()
    decoded = bbox_decode(priors[claimed], bbox[claimed])
    assert torch.allclose(decoded, torch.as_tensor(TEACHER_BOX).expand_as(decoded), atol=1e-3)


def test_the_online_teacher_answers_one_row_per_image() -> None:
    teacher = PriorAssignedTeacher(upscale=4, input_hw=INPUT_HW, detector=FakeDetector(scale=4.0))
    priors = priors_for()
    out = teacher((torch.zeros(3, 3, *INPUT_HW), priors))
    assert flatten_levels(out.cls).shape == (3, priors.shape[0], 1)
    assert flatten_levels(out.kps).shape == (3, priors.shape[0], LANDMARK_COUNT * 2)


def test_feature_distillation_survives_a_teacher_at_another_resolution() -> None:
    """The teacher runs at four times the student's input, so its levels come out
    four times as wide; the term has to resample rather than refuse."""
    loss = FeatureFGDLoss(student_channels=[8], teacher_channels=[8], image_hw=INPUT_HW)
    student = {"s": torch.randn(2, 8, 15, 20)}
    teacher = {"t": torch.randn(2, 8, 60, 80)}
    value = loss(student_features=student, teacher_features=teacher)
    assert value.isfinite()
    assert value.shape == ()


def test_the_cached_teacher_returns_head_shaped_output() -> None:
    """The losses flatten whatever the teacher returns, so it has to arrive in
    head shape or it pairs a prior with a cell from another level."""
    priors = priors_for()
    cls, bbox, kps = teacher_targets(sample_with_teacher(), priors)
    batched = (cls[None], bbox[None], kps[None])

    out = CachedHeadOutput(INPUT_HW)(batched)
    assert len(out.cls) == len(STRIDES)
    assert torch.allclose(flatten_levels(out.cls), cls[None])
    assert torch.allclose(flatten_levels(out.bbox), bbox[None])
    assert torch.allclose(flatten_levels(out.kps), kps[None])
