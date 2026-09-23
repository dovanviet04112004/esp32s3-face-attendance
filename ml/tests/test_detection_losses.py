"""E4-T4: the four detection losses, each on its own."""

from __future__ import annotations

import pytest
import torch

from facepipe.core.registry import LOSSES
from facepipe.tasks.detection.losses import (
    DetectionTargets,
    DetectionTaskLoss,
    giou_loss,
    sigmoid_focal_loss,
)
from facepipe.tasks.detection.model import STRIDES, YuNet, pyramid_priors
from facepipe.tasks.detection.model.head import HeadOutput
from facepipe.tasks.detection.postproc import bbox_encode, kps_encode

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


def test_task_loss_reaches_the_model_weights() -> None:
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


@pytest.mark.parametrize(
    "name",
    [
        "detection_task",
    ],
)
def test_every_loss_is_selectable_from_a_config(name: str) -> None:
    assert name in LOSSES
