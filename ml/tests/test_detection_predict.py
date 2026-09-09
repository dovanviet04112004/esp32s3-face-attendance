"""E4-T6 and E4-T10: turning a checkpoint into the number the branch is graded on."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import torch
from PIL import Image

from facepipe.tasks.detection.data import letterbox_params
from facepipe.tasks.detection.eval import (
    SERVICE_FACE_PX,
    Detections,
    WiderGroundTruth,
    average_precision,
    decode_batch,
    evaluate,
    load_model,
    predict_images,
    size_subset,
    to_original,
)
from facepipe.tasks.detection.model.anchors import feature_sizes, pyramid_priors
from facepipe.tasks.detection.model.yunet import STRIDES, YuNet
from facepipe.tasks.detection.postproc.nms import box_iou, nms, top_k

INPUT_HW = (120, 160)


def test_suppression_keeps_the_best_of_an_overlapping_pile() -> None:
    boxes = np.array(
        [[0, 0, 10, 10], [1, 1, 11, 11], [2, 2, 12, 12], [50, 50, 60, 60]], dtype=np.float64
    )
    scores = np.array([0.9, 0.95, 0.8, 0.7])
    keep = nms(boxes, scores, iou_threshold=0.3)
    assert keep.tolist() == [1, 3]


def test_suppression_keeps_boxes_that_do_not_touch() -> None:
    boxes = np.array([[0, 0, 10, 10], [20, 20, 30, 30], [40, 40, 50, 50]], dtype=np.float64)
    keep = nms(boxes, np.array([0.5, 0.9, 0.7]), iou_threshold=0.3)
    assert sorted(keep.tolist()) == [0, 1, 2]
    assert keep[0] == 1


def test_a_tie_is_broken_by_index_not_by_the_sort() -> None:
    """Two priors can quantise to the same score, and the device has to keep the
    same one Python did."""
    boxes = np.array([[0, 0, 10, 10], [0, 0, 10, 10]], dtype=np.float64)
    assert nms(boxes, np.array([0.5, 0.5]), iou_threshold=0.3).tolist() == [0]


def test_suppression_of_nothing_is_nothing() -> None:
    assert nms(np.zeros((0, 4)), np.zeros(0)).tolist() == []


def test_overlap_is_the_fraction_of_the_union() -> None:
    boxes = np.array([[0, 0, 10, 10], [5, 0, 15, 10]], dtype=np.float64)
    overlaps = box_iou(boxes, np.array([0, 0, 10, 10], dtype=np.float64))
    assert overlaps[0] == pytest.approx(1.0)
    assert overlaps[1] == pytest.approx(50 / 150)


def test_the_cap_takes_the_highest_scores_in_order() -> None:
    scores = np.array([0.1, 0.9, 0.5, 0.7, 0.3])
    assert top_k(scores, 3).tolist() == [1, 3, 2]
    assert top_k(scores, 0).tolist() == [1, 3, 2, 4, 0]


def test_perfect_predictions_score_one() -> None:
    truth = [np.array([[10, 10, 30, 30]], dtype=np.float64)]
    predictions = [np.array([[10, 10, 30, 30, 0.9]], dtype=np.float64)]
    assert average_precision(predictions, truth) == pytest.approx(1.0)


def test_a_detector_that_finds_nothing_scores_zero() -> None:
    truth = [np.array([[10, 10, 30, 30]], dtype=np.float64)]
    assert average_precision([np.zeros((0, 5))], truth) == pytest.approx(0.0)


def test_one_ground_truth_box_can_only_be_hit_once() -> None:
    """Two boxes on one face are one hit and one false positive, so a detector
    that covers half the faces twice scores as if it found half of them."""
    truth = [np.array([[10, 10, 30, 30], [100, 100, 130, 130]], dtype=np.float64)]
    doubled = [np.array([[10, 10, 30, 30, 0.9], [10, 10, 30, 30, 0.8]], dtype=np.float64)]
    assert average_precision(doubled, truth) == pytest.approx(0.5)


def test_a_false_positive_above_a_true_one_costs_precision() -> None:
    """VOC average precision only charges for a wrong box that outranks a right
    one; the same box scored last leaves the envelope untouched."""
    truth = [np.array([[10, 10, 30, 30]], dtype=np.float64)]
    trailing = [np.array([[10, 10, 30, 30, 0.9], [200, 200, 220, 220, 0.1]], dtype=np.float64)]
    leading = [np.array([[200, 200, 220, 220, 0.9], [10, 10, 30, 30, 0.1]], dtype=np.float64)]
    assert average_precision(trailing, truth) == pytest.approx(1.0)
    assert average_precision(leading, truth) == pytest.approx(0.5)


def test_a_box_that_misses_by_more_than_the_threshold_does_not_count() -> None:
    truth = [np.array([[0, 0, 10, 10]], dtype=np.float64)]
    predictions = [np.array([[8, 8, 18, 18, 0.9]], dtype=np.float64)]
    assert average_precision(predictions, truth) == pytest.approx(0.0)


def test_average_precision_of_an_empty_set_is_not_a_number() -> None:
    assert np.isnan(average_precision([np.zeros((0, 5))], [np.zeros((0, 4))]))


def test_letterbox_parameters_fit_the_image_inside_the_canvas() -> None:
    scale, pad_x, pad_y = letterbox_params((200, 400), INPUT_HW)
    assert scale == pytest.approx(0.4)
    assert pad_y == pytest.approx((120 - 80) // 2)
    assert pad_x == 0


def test_mapping_back_undoes_the_letterbox_exactly() -> None:
    """A box drawn on the padded canvas has to land on the same face in the
    original, or every prediction is off by the padding and AP falls silently."""
    original = np.array([[40.0, 60.0, 140.0, 160.0]])
    scale, pad_x, pad_y = letterbox_params((200, 400), INPUT_HW)
    offset = np.array([pad_x, pad_y], dtype=np.float32)
    on_canvas = Detections(
        boxes=original * scale + np.tile(offset, 2),
        scores=np.array([0.9]),
        landmarks=np.zeros((1, 5, 2)),
    )
    assert np.allclose(to_original(on_canvas, scale, pad_x, pad_y).boxes, original, atol=1e-4)


def test_decoding_a_batch_returns_one_result_per_image() -> None:
    model = YuNet().eval()
    priors = torch.cat(pyramid_priors(feature_sizes(INPUT_HW, STRIDES), STRIDES))
    with torch.no_grad():
        found = decode_batch(model(torch.randn(2, 3, *INPUT_HW)), priors, conf=0.0)
    assert len(found) == 2
    for image in found:
        assert image.boxes.shape[1] == 4
        assert image.landmarks.shape[1:] == (5, 2)
        assert len(image.boxes) == len(image.scores) == len(image.landmarks)


def test_a_high_threshold_leaves_nothing_rather_than_raising() -> None:
    model = YuNet().eval()
    priors = torch.cat(pyramid_priors(feature_sizes(INPUT_HW, STRIDES), STRIDES))
    with torch.no_grad():
        found = decode_batch(model(torch.randn(1, 3, *INPUT_HW)), priors, conf=1.1)
    assert len(found[0].boxes) == 0
    assert found[0].xywh_with_score().shape == (0, 5)


def test_a_checkpoint_becomes_predictions_on_the_source_images(tmp_path: Path) -> None:
    """The whole path a run has to survive: weights on disk to boxes in the
    frame the ground truth is written in."""
    images = tmp_path / "0--Parade"
    images.mkdir(parents=True)
    for index in range(2):
        Image.new("RGB", (400, 200), (30 + index * 40, 90, 150)).save(images / f"{index}.jpg")

    ckpt = tmp_path / "best.pth"
    torch.save({"model": YuNet().state_dict()}, ckpt)
    model = load_model(ckpt)

    names = ["0--Parade/0.jpg", "0--Parade/1.jpg"]
    found = predict_images(model, names, tmp_path, INPUT_HW, torch.device("cpu"), conf=0.0)
    assert set(found) == set(names)
    for detections in found.values():
        rows = detections.xywh_with_score()
        assert rows.shape[1] == 5
        # Widths and heights, not a second corner: the kit reads xywh.
        assert (rows[:, 2:4] >= 0).all()


def test_the_ema_copy_is_what_a_checkpoint_loads_back(tmp_path: Path) -> None:
    """A run with EMA on validates its EMA copy, so that is the measured model."""
    live, shadow = YuNet(), YuNet()
    with torch.no_grad():
        for param in shadow.parameters():
            param.add_(1.0)
    ckpt = tmp_path / "best.pth"
    torch.save({"model": live.state_dict(), "ema": {"module": shadow.state_dict()}}, ckpt)

    loaded = load_model(ckpt)
    first = next(iter(loaded.state_dict().values()))
    assert torch.allclose(first, next(iter(shadow.state_dict().values())))


def test_predictions_survive_a_round_trip_through_the_npz(tmp_path: Path) -> None:
    rows = {"0--Parade/0.jpg": np.array([[1.0, 2.0, 3.0, 4.0, 0.5]], dtype=np.float32)}
    path = tmp_path / "predictions.npz"
    np.savez(path, **rows)

    from facepipe.tasks.detection.eval import read_predictions

    back = read_predictions(path)
    assert set(back) == set(rows)
    assert np.allclose(back["0--Parade/0.jpg"], rows["0--Parade/0.jpg"])


def test_the_coco_file_and_the_images_agree_on_names(tmp_path: Path) -> None:
    """predict_images reads names straight from the ground truth, so a name that
    does not exist under images_root has to fail loudly rather than score zero."""
    ckpt = tmp_path / "best.pth"
    torch.save({"model": YuNet().state_dict()}, ckpt)
    (tmp_path / "coco.json").write_text(json.dumps({"images": [], "annotations": []}), "utf-8")

    with pytest.raises(FileNotFoundError):
        predict_images(load_model(ckpt), ["absent.jpg"], tmp_path, INPUT_HW, torch.device("cpu"))


def truth_with(tmp_path: Path, boxes: np.ndarray, size: tuple[int, int] = (480, 640)) -> tuple:
    """One 640x480 image, so the letterbox to 160x120 scales every box by a quarter."""
    height, width = size
    Image.new("RGB", (width, height), (40, 80, 120)).save(tmp_path / "a.jpg")
    truth = WiderGroundTruth(names=["a.jpg"], boxes=[boxes.astype(np.float64)], keep={})
    return truth, tmp_path


def test_the_floor_is_applied_at_the_input_scale_not_in_original_pixels(tmp_path: Path) -> None:
    """A 100 px face in a 640 wide frame is 25 px to the model, so it is below 32."""
    truth, root = truth_with(tmp_path, np.array([[10, 10, 100, 100], [10, 10, 200, 200]]))
    kept = size_subset(truth, root, INPUT_HW, SERVICE_FACE_PX)[0]
    assert kept.tolist() == [1]


def test_the_service_floor_is_the_quarter_of_the_recognition_input(tmp_path: Path) -> None:
    """32 px at the detector is 128 px in the 640x480 frame, above the 112 recog needs."""
    assert SERVICE_FACE_PX * (640 / INPUT_HW[1]) == pytest.approx(128.0)


def test_an_image_with_no_faces_contributes_no_indices(tmp_path: Path) -> None:
    truth, root = truth_with(tmp_path, np.zeros((0, 4)))
    assert size_subset(truth, root, INPUT_HW)[0].size == 0


def test_a_face_below_the_floor_is_ignored_rather_than_counted_wrong(tmp_path: Path) -> None:
    """The gate must not charge the detector for finding a face it does not serve.

    One large face and one small one, both found. Scored on the served subset the
    small hit is removed, so precision stays perfect; counting it as a false
    positive would make finding real faces lower the score.
    """
    truth, root = truth_with(tmp_path, np.array([[10, 10, 200, 200], [400, 300, 60, 60]]))
    truth.keep["served"] = size_subset(truth, root, INPUT_HW)
    assert truth.keep["served"][0].tolist() == [0]

    found = {"a.jpg": np.array([[10, 10, 200, 200, 0.9], [400, 300, 60, 60, 0.8]])}
    assert evaluate(found, truth, settings=("served",))["served"] == pytest.approx(1.0, abs=1e-3)


def test_missing_the_only_served_face_scores_zero(tmp_path: Path) -> None:
    truth, root = truth_with(tmp_path, np.array([[10, 10, 200, 200], [400, 300, 60, 60]]))
    truth.keep["served"] = size_subset(truth, root, INPUT_HW)
    found = {"a.jpg": np.array([[400, 300, 60, 60, 0.9]])}
    assert evaluate(found, truth, settings=("served",))["served"] == pytest.approx(0.0)
