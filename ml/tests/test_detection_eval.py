"""E4-T6: the WIDER FACE protocol, on synthetic sets with known answers."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from facepipe.tasks.detection.eval import (
    ALL_FACES,
    SETTINGS,
    Detections,
    LandmarkGroundTruth,
    WiderGroundTruth,
    evaluate,
    image_evaluation,
    iou_against,
    landmark_error,
    landmark_truth,
    match_faces,
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


def points_in(x: float, y: float, w: float, h: float) -> list[list[float]]:
    fractions = [(0.3, 0.4), (0.7, 0.4), (0.5, 0.6), (0.35, 0.8), (0.65, 0.8)]
    return [[x + fx * w, y + fy * h] for fx, fy in fractions]


def annotation(xywh: list[float], points: list[list[float]] | None = None) -> dict:
    """One face as widerface_to_coco writes it; without points all five sit at -1."""
    if points is None:
        return {"bbox": xywh, "keypoints": [-1.0, -1.0, 0.0] * 5, "num_keypoints": 0}
    keypoints = [value for point in points for value in (*point, 2.0)]
    return {"bbox": xywh, "keypoints": keypoints, "num_keypoints": 5}


def one_image(*faces: dict) -> LandmarkGroundTruth:
    return landmark_truth([("a.jpg", list(faces))])


def detections(boxes: list[list[float]], points: list[list[list[float]]]) -> Detections:
    xywh = np.array(boxes, dtype=float).reshape(-1, 4)
    return Detections(
        boxes=np.concatenate([xywh[:, :2], xywh[:, :2] + xywh[:, 2:]], axis=1),
        scores=np.ones(len(xywh)),
        landmarks=np.array(points, dtype=float).reshape(-1, 5, 2),
    )


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


def test_a_face_takes_the_prediction_it_overlaps_most() -> None:
    faces = np.array([box(0, 0, 20, 20)], dtype=float)
    predicted = np.array([box(3, 3, 20, 20), box(1, 1, 20, 20)], dtype=float)
    assert match_faces(faces, predicted).tolist() == [1]


def test_a_face_overlapped_under_half_is_missed() -> None:
    faces = np.array([box(0, 0, 20, 20)], dtype=float)
    assert match_faces(faces, np.array([box(10, 0, 20, 20)], dtype=float)).tolist() == [-1]


def test_one_prediction_is_matched_to_one_face_only() -> None:
    faces = np.array([box(0, 0, 20, 20), box(3, 0, 20, 20)], dtype=float)
    assert match_faces(faces, np.array([box(1, 0, 20, 20)], dtype=float)).tolist() == [0, -1]


def test_no_prediction_leaves_every_face_unmatched() -> None:
    faces = np.array([box(0, 0, 20, 20), box(40, 0, 20, 20)], dtype=float)
    assert match_faces(faces, np.zeros((0, 4))).tolist() == [-1, -1]


def test_a_point_left_at_minus_one_makes_the_face_incomplete() -> None:
    partial = points_in(40, 0, 20, 20)
    partial[2] = [-1.0, -1.0]
    truth = one_image(
        annotation(box(0, 0, 20, 20), points_in(0, 0, 20, 20)),
        annotation(box(40, 0, 20, 20), partial),
        annotation(box(80, 0, 20, 20)),
    )
    assert truth.complete[0].tolist() == [True, False, False]


def test_faces_without_five_points_are_neither_matched_nor_missed() -> None:
    truth = one_image(
        annotation(box(0, 0, 20, 20), points_in(0, 0, 20, 20)),
        annotation(box(40, 0, 20, 20)),
        annotation(box(80, 0, 20, 20)),
    )
    found = detections(
        [box(0, 0, 20, 20), box(40, 0, 20, 20)],
        [points_in(0, 0, 20, 20), points_in(0, 0, 1, 1)],
    )
    score = landmark_error({"a.jpg": found}, truth)[ALL_FACES]
    assert (score.matched, score.missed, score.skipped) == (1, 0, 2)
    assert score.nmse == pytest.approx(0.0)


def test_a_labelled_face_nothing_found_is_missed() -> None:
    truth = one_image(annotation(box(0, 0, 20, 20), points_in(0, 0, 20, 20)))
    score = landmark_error({}, truth)[ALL_FACES]
    assert (score.matched, score.missed, score.skipped) == (0, 1, 0)
    assert np.isnan(score.nmse)


def test_a_box_on_an_unlabelled_face_is_not_credited_to_its_neighbour() -> None:
    truth = one_image(
        annotation(box(0, 0, 20, 20), points_in(0, 0, 20, 20)),
        annotation(box(3, 0, 20, 20)),
    )
    found = detections([box(3, 0, 20, 20)], [points_in(0, 0, 20, 20)])
    score = landmark_error({"a.jpg": found}, truth)[ALL_FACES]
    assert (score.matched, score.missed, score.skipped) == (0, 1, 1)


def test_the_error_is_read_from_the_prediction_matched_to_the_face() -> None:
    target = points_in(0, 0, 10, 10)
    truth = one_image(annotation(box(0, 0, 10, 10), target))
    shifted = [[x + 1.0, y] for x, y in target]
    found = detections([box(200, 200, 10, 10), box(0, 0, 10, 10)], [points_in(0, 0, 1, 1), shifted])
    assert landmark_error({"a.jpg": found}, truth)[ALL_FACES].nmse == pytest.approx(0.1)


def test_a_face_outside_the_subset_is_not_counted() -> None:
    truth = one_image(
        annotation(box(0, 0, 20, 20), points_in(0, 0, 20, 20)),
        annotation(box(40, 0, 20, 20), points_in(40, 0, 20, 20)),
    )
    truth.keep["first"] = [np.array([0])]
    found = detections([box(0, 0, 20, 20)], [points_in(0, 0, 20, 20)])
    scores = landmark_error({"a.jpg": found}, truth, (ALL_FACES, "first"))
    assert (scores[ALL_FACES].matched, scores[ALL_FACES].missed) == (1, 1)
    assert (scores["first"].matched, scores["first"].missed) == (1, 0)


@pytest.mark.skipif(not GROUND_TRUTH.exists(), reason="WIDER scoring kit not fetched")
def test_the_real_ground_truth_matches_the_published_counts() -> None:
    from facepipe.tasks.detection.eval import load_ground_truth

    truth = load_ground_truth(GROUND_TRUTH)
    assert len(truth) == 3226
    for setting, expected in PUBLISHED.items():
        assert sum(int(k.size) for k in truth.keep[setting]) == expected
