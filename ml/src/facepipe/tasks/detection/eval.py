"""WIDER FACE average precision, and landmark error on device captures.

AP follows the authors' evaluation.m, not a COCO-style mAP, and the gate is the
ge32px column rather than Easy, Medium or Hard (KEHOACH 3, layer 2). Scores are
normalised across the whole prediction set, and a prediction landing outside the
difficulty subset is removed rather than scored - that is what makes them one run.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch

SETTINGS = ("easy", "medium", "hard")
# A quarter of the 640x480 AI frame, so 32 px here is 128 px there: under it the
# aligned crop is upsampled to reach 112x112 recognition (KEHOACH section 3, layer 2).
SERVICE_FACE_PX = 32.0
IOU_THRESHOLD = 0.5
THRESHOLD_STEPS = 1000
# Low on purpose. Average precision is an area under a curve, so cutting the tail
# of low-scoring predictions cuts recall the curve would otherwise have reached.
CONF_THRESHOLD = 0.02
NMS_IOU = 0.3
MAX_DETECTIONS = 750


@dataclass
class Detections:
    """One image's surviving predictions, in whatever frame they were decoded."""

    boxes: np.ndarray
    scores: np.ndarray
    landmarks: np.ndarray

    def xywh_with_score(self) -> np.ndarray:
        """The (N, 5) rows the WIDER kit reads: x, y, width, height, score."""
        if not len(self.boxes):
            return np.zeros((0, 5), dtype=np.float32)
        sizes = self.boxes[:, 2:] - self.boxes[:, :2]
        return np.concatenate([self.boxes[:, :2], sizes, self.scores[:, None]], axis=1)


def empty_detections() -> Detections:
    """What an image with nothing above the threshold returns."""
    return Detections(
        boxes=np.zeros((0, 4), np.float32),
        scores=np.zeros(0, np.float32),
        landmarks=np.zeros((0, 5, 2), np.float32),
    )


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


def size_subset(
    truth: WiderGroundTruth,
    images_root: Path,
    input_hw: tuple[int, int],
    min_face_px: float = SERVICE_FACE_PX,
) -> list[np.ndarray]:
    """Indices of the faces at least min_face_px across once letterboxed to the input.

    Easy, Medium and Hard label difficulty, not size, and at this input the last
    two are mostly faces a few pixels wide (measurements 3). This subset is the
    one that gates the branch; the kit's ignore rule handles the rest.
    """
    from PIL import Image

    from .data import letterbox_params

    subsets: list[np.ndarray] = []
    for name, boxes in zip(truth.names, truth.boxes, strict=True):
        if not len(boxes):
            subsets.append(np.zeros(0, dtype=np.int64))
            continue
        with Image.open(images_root / name) as image:
            width, height = image.size
        scale = letterbox_params((height, width), input_hw)[0]
        sizes = np.clip(boxes[:, 2:4].astype(np.float64), 0.0, None)
        side = np.sqrt(sizes[:, 0] * sizes[:, 1]) * scale
        subsets.append(np.nonzero(side >= min_face_px)[0].astype(np.int64))
    return subsets


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


def average_precision(
    predictions: list[np.ndarray], truth: list[np.ndarray], iou: float = IOU_THRESHOLD
) -> float:
    """One AP over a set of images, both sides in xyxy and the same frame.

    Used while training, where Easy, Medium and Hard do not apply. Letterboxing
    scales prediction and truth alike, so an AP in that frame equals the one in
    original pixels.
    """
    faces = sum(len(boxes) for boxes in truth)
    if not faces:
        return float("nan")

    scored: list[tuple[float, int]] = []
    for prediction, boxes in zip(predictions, truth, strict=True):
        taken = np.zeros(len(boxes), dtype=bool)
        for row in prediction[np.argsort(-prediction[:, 4])] if len(prediction) else []:
            overlaps = iou_xyxy(boxes, row[:4])
            best = int(overlaps.argmax()) if overlaps.size else -1
            hit = best >= 0 and overlaps[best] >= iou and not taken[best]
            if hit:
                taken[best] = True
            scored.append((float(row[4]), int(hit)))

    if not scored:
        return 0.0
    hits = np.array([hit for _, hit in sorted(scored, key=lambda row: -row[0])])
    cumulative = np.cumsum(hits)
    precision = cumulative / np.arange(1, len(hits) + 1)
    return voc_ap(cumulative / faces, precision)


def iou_xyxy(boxes: np.ndarray, box: np.ndarray) -> np.ndarray:
    """Overlap of one xyxy box against many. The kit's own version takes xywh."""
    from .postproc.nms import box_iou

    return box_iou(np.asarray(boxes, dtype=np.float64), np.asarray(box, dtype=np.float64))


def decode_batch(
    out: object,
    priors: torch.Tensor,
    conf: float = CONF_THRESHOLD,
    iou: float = NMS_IOU,
    max_detections: int = MAX_DETECTIONS,
) -> list[Detections]:
    """Head output to per-image detections, in the frame the model was fed.

    The same decode the losses use, then a threshold, a cap and suppression. No
    coordinate mapping: the caller knows whether it is working in letterboxed or
    original pixels, and only one of the two callers needs to leave that frame.
    """
    from .postproc.decode import bbox_decode, flatten_output, kps_decode
    from .postproc.nms import nms, top_k

    cls, bbox, kps = flatten_output(out)
    scores = cls.sigmoid()[..., 0]
    boxes = bbox_decode(priors, bbox)
    points = kps_decode(priors, kps)

    results = []
    for index in range(scores.shape[0]):
        image_scores = scores[index].float().cpu().numpy()
        above = np.nonzero(image_scores >= conf)[0]
        if not above.size:
            results.append(empty_detections())
            continue
        above = above[top_k(image_scores[above], max_detections)]
        image_boxes = boxes[index].float().cpu().numpy()[above]
        keep = nms(image_boxes, image_scores[above], iou)
        chosen = above[keep]
        results.append(
            Detections(
                boxes=boxes[index].float().cpu().numpy()[chosen],
                scores=image_scores[chosen],
                landmarks=points[index].float().cpu().numpy()[chosen].reshape(-1, 5, 2),
            )
        )
    return results


def to_original(detections: Detections, scale: float, pad_x: int, pad_y: int) -> Detections:
    """Undo the loader's letterbox, putting boxes back in the source's pixels."""
    offset = np.array([pad_x, pad_y], dtype=np.float32)
    return Detections(
        boxes=(detections.boxes - np.tile(offset, 2)) / scale,
        scores=detections.scores,
        landmarks=(detections.landmarks - offset) / scale,
    )


@torch.no_grad()
def predict_images(
    model: torch.nn.Module,
    names: list[str],
    images_root: Path,
    input_hw: tuple[int, int],
    device: torch.device,
    conf: float = CONF_THRESHOLD,
    iou: float = NMS_IOU,
) -> dict[str, Detections]:
    """Run the model over a list of image names, returning original-pixel boxes."""
    from PIL import Image

    from .data import letterbox_params
    from .student.anchors import feature_sizes, pyramid_priors
    from .student.yunet import STRIDES

    priors = torch.cat(pyramid_priors(feature_sizes(input_hw, STRIDES), STRIDES)).to(device)
    model.eval()

    out: dict[str, Detections] = {}
    for name in names:
        source = np.asarray(Image.open(Path(images_root) / name).convert("RGB"), dtype=np.uint8)
        height, width = source.shape[:2]
        scale, pad_x, pad_y = letterbox_params((height, width), input_hw)
        resized = np.asarray(
            Image.fromarray(source).resize(
                (round(width * scale), round(height * scale)), Image.BILINEAR
            ),
            dtype=np.uint8,
        )
        canvas = np.zeros((*input_hw, 3), dtype=np.uint8)
        canvas[pad_y : pad_y + resized.shape[0], pad_x : pad_x + resized.shape[1]] = resized

        tensor = torch.from_numpy(canvas).permute(2, 0, 1).float().div_(255.0)[None].to(device)
        detections = decode_batch(model(tensor), priors, conf, iou)[0]
        out[name] = to_original(detections, scale, pad_x, pad_y)
    return out


def read_predictions(path: Path) -> dict[str, np.ndarray]:
    """Load predictions written as one npz of name to (N, 5) xywh-score rows."""
    with np.load(path, allow_pickle=False) as payload:
        return {name: payload[name] for name in payload.files}


def load_student(ckpt: Path, params: dict | None = None) -> torch.nn.Module:
    """Rebuild the student and load a run's weights, preferring its EMA copy."""
    from facepipe.core.registry import MODELS

    from .student import yunet  # noqa: F401  registers "yunet"

    model = MODELS.build({"name": "yunet", "params": params or {}})
    payload = torch.load(ckpt, map_location="cpu", weights_only=False)
    state = payload["ema"]["module"] if "ema" in payload else payload.get("model", payload)
    model.load_state_dict(state)
    return model


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ckpt", type=Path, default=None, help="run a checkpoint over the images")
    parser.add_argument("--predictions", type=Path, default=None, help="score a saved npz instead")
    parser.add_argument(
        "--images", type=Path, default=Path("data/raw/detection/widerface/WIDER_val/images")
    )
    parser.add_argument("--input-hw", type=int, nargs=2, default=(120, 160))
    parser.add_argument("--min-face-px", type=float, default=SERVICE_FACE_PX)
    parser.add_argument("--save-predictions", type=Path, default=None)
    parser.add_argument(
        "--ground-truth",
        type=Path,
        default=Path("data/raw/detection/widerface/eval_tools/ground_truth"),
    )
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = parser.parse_args(argv)

    if (args.ckpt is None) == (args.predictions is None):
        parser.error("pass exactly one of --ckpt and --predictions")

    truth = load_ground_truth(args.ground_truth)
    if args.predictions is not None:
        predictions = read_predictions(args.predictions)
    else:
        model = load_student(args.ckpt).to(args.device)
        detected = predict_images(
            model, truth.names, args.images, tuple(args.input_hw), torch.device(args.device)
        )
        predictions = {name: found.xywh_with_score() for name, found in detected.items()}
        if args.save_predictions is not None:
            args.save_predictions.parent.mkdir(parents=True, exist_ok=True)
            np.savez(args.save_predictions, **predictions)

    served = f"ge{args.min_face_px:g}px"
    truth.keep[served] = size_subset(truth, args.images, tuple(args.input_hw), args.min_face_px)
    settings = (*SETTINGS, served)

    scores = evaluate(predictions, truth, settings)
    for setting in settings:
        print(f"{setting:8s} AP {scores[setting]:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
