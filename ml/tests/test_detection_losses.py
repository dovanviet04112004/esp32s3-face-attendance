"""E4-T4: the four detection losses, each on its own."""

from __future__ import annotations

import pytest
import torch

from facepipe.core.registry import LOSSES
from facepipe.tasks.detection.losses import (
    DetectionTargets,
    DetectionTaskLoss,
    FeatureFGDLoss,
    LocalizationDistillLoss,
    LogitDistillLoss,
    attention,
    binary_kl,
    foreground_mask,
    giou_loss,
    sigmoid_focal_loss,
)
from facepipe.tasks.detection.postproc import bbox_encode, kps_encode
from facepipe.tasks.detection.student import STRIDES, YuNet, pyramid_priors
from facepipe.tasks.detection.student.head import HeadOutput

FEAT_SIZES = [(4, 4), (2, 2), (1, 1)]
NUM_PRIORS = sum(h * w for h, w in FEAT_SIZES)


def make_output(batch: int = 2, fill: float = 0.0) -> HeadOutput:
    def maps(channels: int) -> list[torch.Tensor]:
        return [torch.full((batch, channels, h, w), fill) for h, w in FEAT_SIZES]

    return HeadOutput(cls=maps(1), bbox=maps(4), kps=maps(10))


def make_targets(batch: int = 2, with_landmarks: bool = True) -> DetectionTargets:
    priors = torch.cat(pyramid_priors(FEAT_SIZES, STRIDES))
    labels = torch.zeros(batch, NUM_PRIORS, dtype=torch.long)
    labels[:, 0] = 1
    boxes = torch.zeros(batch, NUM_PRIORS, 4)
    boxes[:, 0] = torch.tensor([2.0, 2.0, 18.0, 18.0])
    landmarks = torch.zeros(batch, NUM_PRIORS, 10)
    landmarks[:, 0] = torch.tensor([5.0, 6.0, 13.0, 6.0, 9.0, 10.0, 6.0, 14.0, 12.0, 14.0])
    mask = torch.zeros(batch, NUM_PRIORS, dtype=torch.bool)
    if with_landmarks:
        mask[:, 0] = True
    return DetectionTargets(
        labels=labels,
        boxes=boxes,
        landmarks=landmarks,
        landmark_mask=mask,
        priors=priors,
        gt_boxes=[torch.tensor([[2.0, 2.0, 18.0, 18.0]]) for _ in range(batch)],
    )


def perfect_output(targets: DetectionTargets, batch: int = 2) -> HeadOutput:
    """Head output that reproduces the targets exactly, level by level."""
    priors = targets.priors
    bbox = bbox_encode(priors, targets.boxes)
    kps = kps_encode(priors, targets.landmarks)
    cls = torch.where(targets.positives, 20.0, -20.0).unsqueeze(-1)

    out_cls, out_bbox, out_kps = [], [], []
    start = 0
    for h, w in FEAT_SIZES:
        stop = start + h * w
        for source, sink, channels in ((cls, out_cls, 1), (bbox, out_bbox, 4), (kps, out_kps, 10)):
            chunk = source[:, start:stop].reshape(batch, h, w, channels)
            sink.append(chunk.permute(0, 3, 1, 2).contiguous())
        start = stop
    return HeadOutput(cls=out_cls, bbox=out_bbox, kps=out_kps)


def test_giou_is_zero_for_identical_boxes() -> None:
    box = torch.tensor([[0.0, 0.0, 10.0, 10.0]])
    assert giou_loss(box, box).item() == pytest.approx(0.0, abs=1e-6)


def test_giou_still_has_signal_when_boxes_do_not_overlap() -> None:
    a = torch.tensor([[0.0, 0.0, 10.0, 10.0]])
    far = torch.tensor([[100.0, 100.0, 110.0, 110.0]])
    near = torch.tensor([[20.0, 20.0, 30.0, 30.0]])
    assert giou_loss(a, far).item() > giou_loss(a, near).item() > 1.0


def test_focal_loss_discounts_easy_negatives() -> None:
    easy = torch.full((1, 100, 1), -8.0)
    hard = torch.full((1, 100, 1), 0.0)
    zeros = torch.zeros(1, 100, 1)
    assert sigmoid_focal_loss(easy, zeros) < 0.02 * sigmoid_focal_loss(hard, zeros)


def test_task_loss_bottoms_out_on_a_perfect_prediction() -> None:
    targets = make_targets()
    loss = DetectionTaskLoss()
    assert loss(perfect_output(targets), targets).item() < 1e-3


def test_task_loss_penalises_a_shifted_box() -> None:
    targets = make_targets()
    loss = DetectionTaskLoss()
    good = perfect_output(targets)
    shifted = HeadOutput(cls=good.cls, bbox=[b + 0.5 for b in good.bbox], kps=good.kps)
    assert loss(shifted, targets).item() > loss(good, targets).item()


def test_faces_without_landmark_labels_skip_the_landmark_term() -> None:
    loss = DetectionTaskLoss()
    with_lm = make_targets(with_landmarks=True)
    without = make_targets(with_landmarks=False)
    out = perfect_output(with_lm)
    wrong = HeadOutput(cls=out.cls, bbox=out.bbox, kps=[k + 5.0 for k in out.kps])
    assert loss(wrong, without).item() < loss(wrong, with_lm).item()


def test_task_loss_reaches_the_student_weights() -> None:
    model = YuNet()
    out = model(torch.randn(2, 3, 120, 160))
    sizes = [tuple(t.shape[-2:]) for t in out.cls]
    total = sum(h * w for h, w in sizes)

    labels = torch.zeros(2, total, dtype=torch.long)
    labels[:, 0] = 1
    boxes = torch.zeros(2, total, 4)
    boxes[:, 0] = torch.tensor([2.0, 2.0, 18.0, 18.0])
    targets = DetectionTargets(
        labels=labels,
        boxes=boxes,
        landmarks=torch.zeros(2, total, 10),
        landmark_mask=torch.zeros(2, total, dtype=torch.bool),
        priors=torch.cat(pyramid_priors(sizes, STRIDES)),
    )

    DetectionTaskLoss()(out, targets).backward()
    assert model.backbone.stages[0].conv.weight.grad.abs().sum() > 0


def test_logit_kd_vanishes_when_the_two_agree() -> None:
    out = make_output(fill=0.7)
    assert LogitDistillLoss()(out, out).item() == pytest.approx(0.0, abs=1e-6)


def test_logit_kd_grows_with_disagreement() -> None:
    loss = LogitDistillLoss()
    teacher = make_output(fill=3.0)
    near = make_output(fill=2.0)
    far = make_output(fill=-3.0)
    assert loss(far, teacher).item() > loss(near, teacher).item() > 0


def test_binary_kl_keeps_the_background_half() -> None:
    student = torch.tensor([[-4.0]])
    teacher = torch.tensor([[-1.0]])
    assert binary_kl(student, teacher).item() > 0


def test_temperature_squared_keeps_the_gradient_scale() -> None:
    grads = []
    for temperature in (1.0, 4.0):
        student = make_output(fill=0.5)
        student.cls[0].requires_grad_(True)
        LogitDistillLoss(temperature=temperature)(student, make_output(fill=1.5)).backward()
        grads.append(student.cls[0].grad.abs().mean().item())
    assert grads[1] == pytest.approx(grads[0], rel=0.35)


def test_non_positive_temperature_is_rejected() -> None:
    with pytest.raises(ValueError, match="temperature"):
        LogitDistillLoss(temperature=0.0)


def test_localization_kd_vanishes_when_the_two_agree() -> None:
    targets = make_targets()
    out = perfect_output(targets)
    loss = LocalizationDistillLoss()
    assert loss(out, out, targets).item() == pytest.approx(0.0, abs=1e-6)


def test_localization_kd_ignores_priors_the_teacher_is_unsure_about() -> None:
    targets = make_targets()
    teacher = make_output(fill=-10.0)
    student = make_output(fill=1.0)
    assert LocalizationDistillLoss()(student, teacher, targets).item() == 0.0


def test_localization_kd_covers_landmarks_as_well_as_boxes() -> None:
    targets = make_targets()
    teacher = perfect_output(targets)
    student = HeadOutput(cls=teacher.cls, bbox=teacher.bbox, kps=[k + 1.0 for k in teacher.kps])
    with_kps = LocalizationDistillLoss()(student, teacher, targets).item()
    boxes_only = LocalizationDistillLoss(kps_weight=0.0)(student, teacher, targets).item()
    assert with_kps > 0 and boxes_only == pytest.approx(0.0, abs=1e-6)


def test_localization_kd_needs_priors_to_decode_with() -> None:
    out = make_output()
    with pytest.raises(ValueError, match="priors"):
        LocalizationDistillLoss()(out, out, None)


def test_foreground_mask_is_zero_outside_the_box() -> None:
    boxes = torch.tensor([[0.0, 0.0, 8.0, 8.0]])
    mask = foreground_mask(boxes, (8, 8), (32, 32))
    assert mask[:2, :2].gt(0).all()
    assert mask[4:, 4:].eq(0).all()


def test_small_faces_get_more_weight_per_cell_than_large_ones() -> None:
    small = foreground_mask(torch.tensor([[0.0, 0.0, 8.0, 8.0]]), (16, 16), (32, 32))
    large = foreground_mask(torch.tensor([[0.0, 0.0, 32.0, 32.0]]), (16, 16), (32, 32))
    assert small.max() > large.max()


def test_empty_box_list_produces_an_empty_mask() -> None:
    assert foreground_mask(torch.zeros(0, 4), (4, 4), (16, 16)).sum() == 0


def test_attention_maps_sum_to_their_own_size() -> None:
    feat = torch.randn(2, 8, 4, 4).abs()
    spatial, channel = attention(feat, temperature=0.5)
    assert spatial.sum(dim=(1, 2, 3)).allclose(torch.full((2,), 16.0), atol=1e-4)
    assert channel.sum(dim=(1, 2, 3)).allclose(torch.full((2,), 8.0), atol=1e-4)


def fgd_pair() -> tuple[FeatureFGDLoss, dict, dict, DetectionTargets]:
    loss = FeatureFGDLoss(
        student_channels=[16], teacher_channels=[24], image_hw=(32, 32), layers=["neck.0"]
    )
    student = {"neck.0": torch.randn(2, 16, 8, 8)}
    teacher = {"neck.0": torch.randn(2, 24, 8, 8)}
    return loss, student, teacher, make_targets()


def test_fgd_runs_and_stays_differentiable() -> None:
    loss, student, teacher, targets = fgd_pair()
    student["neck.0"].requires_grad_(True)
    value = loss(batch=targets, student_features=student, teacher_features=teacher)
    value.backward()
    assert torch.isfinite(value) and student["neck.0"].grad.abs().sum() > 0


def test_fgd_separates_the_foreground_and_background_weights() -> None:
    loss, student, teacher, targets = fgd_pair()
    baseline = loss(batch=targets, student_features=student, teacher_features=teacher).item()
    loss.fg_weight = 10.0
    assert loss(batch=targets, student_features=student, teacher_features=teacher).item() > baseline


def test_fgd_without_hooks_is_an_error() -> None:
    loss, _, teacher, targets = fgd_pair()
    with pytest.raises(ValueError, match="hooks"):
        loss(batch=targets, student_features=None, teacher_features=teacher)


def test_fgd_rejects_a_level_count_mismatch() -> None:
    with pytest.raises(ValueError, match="level"):
        FeatureFGDLoss(student_channels=[16, 16], teacher_channels=[24], image_hw=(32, 32))


@pytest.mark.parametrize(
    "name",
    [
        "detection_task",
        "detection_kd_logit",
        "detection_kd_localization",
        "detection_kd_feature_fgd",
    ],
)
def test_every_loss_is_selectable_from_a_config(name: str) -> None:
    assert name in LOSSES
