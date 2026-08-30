"""WIDER FACE average precision, and landmark error on device captures.

The AP here follows the authors' evaluation.m rather than a COCO-style mAP. The
0.884 / 0.866 / 0.750 figures the plan quotes for YuNet, and the 0.80 the teacher
has to clear, are all on this protocol; a number from any other one cannot be
compared with them however close it looks.

Two details decide whether the result means anything. Scores are normalised
across the whole prediction set before thresholding, so a detector with a narrow
score range is not punished. Ground-truth boxes outside the difficulty subset are
neither targets nor false positives: a prediction landing on one is removed from
the count instead of scored, which is what makes Easy, Medium and Hard three
readings of one prediction set.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SETTINGS = ("easy", "medium", "hard")
IOU_THRESHOLD = 0.5
THRESHOLD_STEPS = 1000


@dataclass
class WiderGroundTruth:
    """Boxes per image, and the subset each difficulty counts."""

    names: list[str]
    boxes: list[np.ndarray]
    keep: dict[str, list[np.ndarray]]

    def __len__(self) -> int:
        return len(self.names)


def load_ground_truth(root: Path, settings: tuple[str, ...] = SETTINGS) -> WiderGroundTruth:
    """Read the kit's MATLAB ground truth into flat per-image lists."""
    from scipy.io import loadmat

    payload = loadmat(str(root / "wider_face_val.mat"))
    events, files, boxes = payload["event_list"], payload["file_list"], payload["face_bbx_list"]

    names: list[str] = []
    per_image: list[np.ndarray] = []
    for event in range(events.shape[0]):
        event_name = str(events[event][0][0])
        for image in range(files[event][0].shape[0]):
            names.append(f"{event_name}/{files[event][0][image][0][0]}.jpg")
            per_image.append(np.asarray(boxes[event][0][image][0], dtype=np.float64))

    keep: dict[str, list[np.ndarray]] = {}
    for setting in settings:
        listed = loadmat(str(root / f"wider_{setting}_val.mat"))["gt_list"]
        flat: list[np.ndarray] = []
        for event in range(listed.shape[0]):
            for image in range(listed[event][0].shape[0]):
                # MATLAB indices are 1-based and the array is empty when the
                # subset keeps nothing from this image.
                indices = np.asarray(listed[event][0][image][0]).ravel().astype(np.int64)
                flat.append(indices - 1)
        keep[setting] = flat
    return WiderGroundTruth(names=names, boxes=per_image, keep=keep)


def normalize_scores(predictions: list[np.ndarray]) -> list[np.ndarray]:
    """Rescale every score into [0, 1] using the extremes of the whole set."""
    # A detector that finds nothing has to score zero, not raise.
    columns = [p[:, 4] for p in predictions if len(p)]
    if not columns:
        return predictions
    scores = np.concatenate(columns)
    low, high = float(scores.min()), float(scores.max())
    span = high - low
    if span <= 0:
        return predictions
    out = []
    for prediction in predictions:
        if not len(prediction):
            out.append(prediction)
            continue
        scaled = prediction.copy()
        scaled[:, 4] = (scaled[:, 4] - low) / span
        out.append(scaled)
    return out


def iou_against(boxes: np.ndarray, box: np.ndarray) -> np.ndarray:
    """Overlap of one xywh box against many, in the kit's own convention."""
    if not len(boxes):
        return np.zeros(0)
    gt_x2, gt_y2 = boxes[:, 0] + boxes[:, 2], boxes[:, 1] + boxes[:, 3]
    x2, y2 = box[0] + box[2], box[1] + box[3]

    width = np.minimum(gt_x2, x2) - np.maximum(boxes[:, 0], box[0])
    height = np.minimum(gt_y2, y2) - np.maximum(boxes[:, 1], box[1])
    overlap = np.clip(width, 0, None) * np.clip(height, 0, None)
    union = boxes[:, 2] * boxes[:, 3] + box[2] * box[3] - overlap
    return np.where(union > 0, overlap / np.maximum(union, 1e-12), 0.0)


def image_evaluation(
    prediction: np.ndarray, boxes: np.ndarray, keep: np.ndarray, iou: float = IOU_THRESHOLD
) -> tuple[np.ndarray, np.ndarray]:
    """Per-prediction recall count and validity, matching greedily by score.

    A prediction that lands on a box outside the subset is marked invalid rather
    than counted wrong, which is what lets one prediction set be read three ways.
    """
    counted = np.zeros(len(boxes), dtype=bool)
    counted[keep[(keep >= 0) & (keep < len(boxes))]] = True

    recalled = np.zeros(len(boxes), dtype=np.int64)
    valid = np.ones(len(prediction), dtype=np.int64)
    running = np.zeros(len(prediction), dtype=np.int64)

    for index in range(len(prediction)):
        overlaps = iou_against(boxes, prediction[index, :4])
        if overlaps.size and overlaps.max() >= iou:
            best = int(overlaps.argmax())
            if not counted[best]:
                recalled[best] = -1
                valid[index] = -1
            elif recalled[best] == 0:
                recalled[best] = 1
        running[index] = int((recalled == 1).sum())
    return running, valid


def image_pr_info(
    prediction: np.ndarray, running: np.ndarray, valid: np.ndarray, steps: int = THRESHOLD_STEPS
) -> np.ndarray:
    """Valid predictions and recalled faces at each score threshold."""
    info = np.zeros((steps, 2), dtype=np.int64)
    if not len(prediction):
        return info
    for step in range(steps):
        threshold = 1.0 - (step + 1) / steps
        above = np.nonzero(prediction[:, 4] >= threshold)[0]
        if not above.size:
            continue
        last = int(above[-1])
        info[step, 0] = int((valid[: last + 1] == 1).sum())
        info[step, 1] = int(running[last])
    return info


def voc_ap(recall: np.ndarray, precision: np.ndarray) -> float:
    """Area under the precision envelope, the kit's VOCap."""
    mrec = np.concatenate([[0.0], recall, [1.0]])
    mpre = np.concatenate([[0.0], precision, [0.0]])
    for index in range(len(mpre) - 2, -1, -1):
        mpre[index] = max(mpre[index], mpre[index + 1])
    changes = np.nonzero(mrec[1:] != mrec[:-1])[0] + 1
    return float(((mrec[changes] - mrec[changes - 1]) * mpre[changes]).sum())


def evaluate(
    predictions: dict[str, np.ndarray],
    truth: WiderGroundTruth,
    settings: tuple[str, ...] = SETTINGS,
    steps: int = THRESHOLD_STEPS,
) -> dict[str, float]:
    """Average precision per difficulty, over the whole validation set."""
    scaled = normalize_scores([predictions.get(name, np.zeros((0, 5))) for name in truth.names])

    results: dict[str, float] = {}
    for setting in settings:
        totals = np.zeros((steps, 2), dtype=np.int64)
        faces = 0
        for index in range(len(truth)):
            keep = truth.keep[setting][index]
            faces += int(keep.size)
            if not keep.size:
                continue
            running, valid = image_evaluation(scaled[index], truth.boxes[index], keep)
            totals += image_pr_info(scaled[index], running, valid, steps)

        proposals = np.maximum(totals[:, 0], 1)
        precision = totals[:, 1] / proposals
        recall = totals[:, 1] / max(faces, 1)
        results[setting] = voc_ap(recall, precision)
    return results


def normalized_mean_error(predicted: np.ndarray, target: np.ndarray, boxes: np.ndarray) -> float:
    """Landmark error as a fraction of face size, the NMSE the plan bounds at 5%.

    Normalising by the square root of box area rather than inter-ocular distance
    keeps the number meaningful on profile faces, where the two eyes converge and
    an inter-ocular denominator explodes.
    """
    if not len(predicted):
        return float("nan")
    scale = np.sqrt(
        np.maximum(boxes[:, 2] - boxes[:, 0], 0) * np.maximum(boxes[:, 3] - boxes[:, 1], 0)
    )
    distance = np.linalg.norm(predicted - target, axis=-1)
    return float((distance / np.maximum(scale[:, None], 1e-9)).mean())


def read_predictions(path: Path) -> dict[str, np.ndarray]:
    """Load predictions written as one npz of name to (N, 5) xywh-score rows."""
    with np.load(path, allow_pickle=False) as payload:
        return {name: payload[name] for name in payload.files}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument(
        "--ground-truth",
        type=Path,
        default=Path("data/raw/detection/widerface/eval_tools/ground_truth"),
    )
    args = parser.parse_args(argv)

    truth = load_ground_truth(args.ground_truth)
    scores = evaluate(read_predictions(args.predictions), truth)
    for setting in SETTINGS:
        print(f"{setting:7s} AP {scores[setting]:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
