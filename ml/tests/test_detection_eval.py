"""E4-T6: the WIDER FACE protocol, on synthetic sets with known answers."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from facepipe.tasks.detection.eval import (
    SETTINGS,
    WiderGroundTruth,
    evaluate,
    image_evaluation,
    iou_against,
    normalize_scores,
    normalized_mean_error,
    voc_ap,
)

GROUND_TRUTH = Path("data/raw/detection/widerface/eval_tools/ground_truth")
# Published WIDER FACE validation counts; the loader is wrong if these move.
PUBLISHED = {"easy": 7211, "medium": 13319, "hard": 31958}


def box(x: float, y: float, w: float, h: float) -> list[float]:
    return [x, y, w, h]


def synthetic(keep_all: bool = True) -> WiderGroundTruth:
    boxes = [
        np.array([box(10, 10, 20, 20), box(50, 50, 30, 30)], dtype=float),
        np.array([box(5, 5, 40, 40)], dtype=float),
    ]
    keep = [np.array([0, 1]), np.array([0])] if keep_all else [np.array([0]), np.array([0])]
    return WiderGroundTruth(names=["a.jpg", "b.jpg"], boxes=boxes, keep={s: keep for s in SETTINGS})


def test_overlap_of_a_box_with_itself_is_one() -> None:
    boxes = np.array([box(0, 0, 10, 10)], dtype=float)
    assert iou_against(boxes, np.array(box(0, 0, 10, 10), dtype=float))[0] == pytest.approx(1.0)


def test_boxes_that_do_not_touch_have_no_overlap() -> None:
    boxes = np.array([box(0, 0, 10, 10)], dtype=float)
    assert iou_against(boxes, np.array(box(100, 100, 10, 10), dtype=float))[0] == 0.0


def test_half_covered_boxes_give_a_third() -> None:
    boxes = np.array([box(0, 0, 10, 10)], dtype=float)
    value = iou_against(boxes, np.array(box(5, 0, 10, 10), dtype=float))[0]
    assert value == pytest.approx(50 / 150)


def test_average_precision_of_a_perfect_curve_is_one() -> None:
    recall = np.linspace(0, 1, 50)
    assert voc_ap(recall, np.ones_like(recall)) == pytest.approx(1.0)


def test_average_precision_of_nothing_recalled_is_zero() -> None:
    assert voc_ap(np.zeros(10), np.zeros(10)) == pytest.approx(0.0)


def test_scores_are_rescaled_across_the_whole_set() -> None:
    predictions = [
        np.array([[0, 0, 1, 1, 3.0], [0, 0, 1, 1, 5.0]]),
        np.array([[0, 0, 1, 1, 7.0]]),
    ]
    scaled = normalize_scores(predictions)
    assert scaled[0][0, 4] == pytest.approx(0.0)
    assert scaled[1][0, 4] == pytest.approx(1.0)


def test_one_score_everywhere_is_left_alone() -> None:
    predictions = [np.array([[0, 0, 1, 1, 2.0]])]
    assert normalize_scores(predictions)[0][0, 4] == 2.0


def test_a_prediction_on_a_face_outside_the_subset_is_neutralised() -> None:
    boxes = np.array([box(10, 10, 20, 20), box(50, 50, 30, 30)], dtype=float)
    prediction = np.array([[50, 50, 30, 30, 1.0]], dtype=float)
    running, valid = image_evaluation(prediction, boxes, keep=np.array([0]))
    assert valid[0] == -1
    assert running[0] == 0


def test_a_prediction_on_a_face_inside_the_subset_counts() -> None:
    boxes = np.array([box(10, 10, 20, 20)], dtype=float)
    prediction = np.array([[10, 10, 20, 20, 1.0]], dtype=float)
    running, valid = image_evaluation(prediction, boxes, keep=np.array([0]))
    assert valid[0] == 1 and running[0] == 1


def test_the_same_face_is_not_recalled_twice() -> None:
    boxes = np.array([box(10, 10, 20, 20)], dtype=float)
    prediction = np.array([[10, 10, 20, 20, 0.9], [11, 11, 20, 20, 0.8]], dtype=float)
    running, _ = image_evaluation(prediction, boxes, keep=np.array([0]))
    assert running.tolist() == [1, 1]


def test_predicting_every_face_exactly_scores_near_one() -> None:
    truth = synthetic()
    predictions = {
        name: np.column_stack([boxes, np.ones(len(boxes))])
        for name, boxes in zip(truth.names, truth.boxes, strict=True)
    }
    scores = evaluate(predictions, truth)
    assert all(scores[s] > 0.99 for s in SETTINGS)


def test_predicting_nothing_scores_zero() -> None:
    truth = synthetic()
    scores = evaluate({}, truth)
    assert all(scores[s] == pytest.approx(0.0) for s in SETTINGS)


def test_a_wrong_box_everywhere_scores_zero() -> None:
    truth = synthetic()
    predictions = {name: np.array([[900, 900, 5, 5, 1.0]]) for name in truth.names}
    scores = evaluate(predictions, truth)
    assert all(scores[s] == pytest.approx(0.0) for s in SETTINGS)


def test_landmark_error_is_zero_on_an_exact_prediction() -> None:
    points = np.random.default_rng(0).random((4, 5, 2)) * 50
    boxes = np.tile(np.array([0.0, 0.0, 50.0, 50.0]), (4, 1))
    assert normalized_mean_error(points, points, boxes) == pytest.approx(0.0)


def test_landmark_error_scales_with_face_size() -> None:
    target = np.zeros((1, 5, 2))
    predicted = np.full((1, 5, 2), 1.0)
    small = normalized_mean_error(predicted, target, np.array([[0.0, 0.0, 10.0, 10.0]]))
    large = normalized_mean_error(predicted, target, np.array([[0.0, 0.0, 100.0, 100.0]]))
    assert small > large


@pytest.mark.skipif(not GROUND_TRUTH.exists(), reason="WIDER scoring kit not fetched")
def test_the_real_ground_truth_matches_the_published_counts() -> None:
    from facepipe.tasks.detection.eval import load_ground_truth

    truth = load_ground_truth(GROUND_TRUTH)
    assert len(truth) == 3226
    for setting, expected in PUBLISHED.items():
        assert sum(int(k.size) for k in truth.keep[setting]) == expected
