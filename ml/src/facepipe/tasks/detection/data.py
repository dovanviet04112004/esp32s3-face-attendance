"""Dataset, augmentation and prior assignment for the detection branch.

Two rules shape this file.

Augmentation is applied to the teacher's cached detections in the same call that
applies it to the real labels. Transforming one and not the other leaves the
student imitating geometry from a differently-cropped image, and the loss still
falls (KEHOACH section 3, layer 2).

The recipe is identical across all four arms of section 3.7. Only the loss may
differ between arms, so nothing here may read whether a teacher is present.
"""

from __future__ import annotations

import json
import random
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch.utils.data import Dataset

from facepipe.core.registry import DATASETS

from .losses.task_loss import DetectionTargets
from .postproc.decode import bbox_encode, kps_encode
from .student.anchors import feature_sizes, pyramid_priors
from .student.head import LANDMARK_COUNT
from .student.yunet import STRIDES

# Mirroring swaps the two eyes and the two mouth corners; the nose stays put.
FLIP_INDEX = (1, 0, 2, 4, 3)

# Level of a face by the square root of its box area, split 61/34/5 percent on the
# distribution crop_scale produces (KEHOACH section 3, layer 2).
LEVEL_RANGES = ((0.0, 16.0), (16.0, 48.0), (48.0, 1e9))
CENTER_RADIUS = 1.5

# One cell of the finest level. A box smaller than the grid that has to place it
# cannot be regressed, so such a face is dropped rather than learned as noise.
MIN_FACE_PX = 8.0
# Fraction of the frame a random window takes. Without it the student only ever
# meets WIDER at one scale, and never a face the size the kiosk will show it.
CROP_SCALE = (0.3, 1.0)

TEACHER_SCORE_EPS = 1e-4
# logit(TEACHER_SCORE_EPS): what a prior no teacher box claimed is worth.
TEACHER_BACKGROUND_LOGIT = -9.2103


@dataclass
class Sample:
    """One image with every annotation that must move when the image moves."""

    image: np.ndarray
    boxes: np.ndarray
    landmarks: np.ndarray
    has_landmarks: np.ndarray
    teacher_boxes: np.ndarray = field(default_factory=lambda: np.zeros((0, 4), np.float32))
    teacher_scores: np.ndarray = field(default_factory=lambda: np.zeros((0,), np.float32))
    teacher_landmarks: np.ndarray = field(
        default_factory=lambda: np.zeros((0, LANDMARK_COUNT, 2), np.float32)
    )


def letterbox_params(in_hw: tuple[int, int], out_hw: tuple[int, int]) -> tuple[float, int, int]:
    """Scale and padding that fit in_hw inside out_hw, as (scale, pad_x, pad_y).

    Evaluation has to undo exactly what the loader did, so both read the geometry
    from here. A second copy of this arithmetic would put every predicted box a
    few pixels off its face, which lowers AP without ever looking like a bug.
    """
    scale = min(out_hw[0] / in_hw[0], out_hw[1] / in_hw[1])
    new_h, new_w = round(in_hw[0] * scale), round(in_hw[1] * scale)
    return scale, (out_hw[1] - new_w) // 2, (out_hw[0] - new_h) // 2


def letterbox(sample: Sample, out_hw: tuple[int, int]) -> Sample:
    """Fit the image into out_hw keeping its aspect, padding the remainder.

    Stretching instead would change face aspect ratio, and the landmark head
    would learn a distortion the camera never produces.
    """
    height, width = sample.image.shape[:2]
    scale, pad_x, pad_y = letterbox_params((height, width), out_hw)
    new_h, new_w = round(height * scale), round(width * scale)

    resized = np.asarray(
        Image.fromarray(sample.image).resize((new_w, new_h), Image.BILINEAR), dtype=np.uint8
    )
    canvas = np.zeros((*out_hw, 3), dtype=np.uint8)
    canvas[pad_y : pad_y + new_h, pad_x : pad_x + new_w] = resized

    offset = np.array([pad_x, pad_y], dtype=np.float32)
    return Sample(
        image=canvas,
        boxes=sample.boxes * scale + np.tile(offset, 2),
        landmarks=sample.landmarks * scale + offset,
        has_landmarks=sample.has_landmarks,
        teacher_boxes=sample.teacher_boxes * scale + np.tile(offset, 2),
        teacher_scores=sample.teacher_scores,
        teacher_landmarks=sample.teacher_landmarks * scale + offset,
    )


def _inside(boxes: np.ndarray, window: tuple[int, int, int, int]) -> np.ndarray:
    """Which boxes have their centre in the window."""
    if not len(boxes):
        return np.zeros(0, dtype=bool)
    left, top, right, bottom = window
    centre_x = (boxes[:, 0] + boxes[:, 2]) / 2
    centre_y = (boxes[:, 1] + boxes[:, 3]) / 2
    return (centre_x > left) & (centre_x < right) & (centre_y > top) & (centre_y < bottom)


def random_crop(
    sample: Sample, rng: random.Random, scale: tuple[float, float] = CROP_SCALE
) -> Sample:
    """Take a random window of the image, so a face can appear at any size.

    Without this the student only ever sees WIDER at one scale, which at 160x120
    means a median face of 2.9 pixels, while the kiosk will show it one face
    filling a fifth of the frame (KEHOACH section 3, layer 2).

    A face whose centre falls outside the window is dropped rather than clipped:
    a box cut by an edge no longer describes a face, and the box head would learn
    that shape as if it did.
    """
    height, width = sample.image.shape[:2]
    factor = rng.uniform(*scale)
    crop_h = max(1, min(height, round(height * factor)))
    crop_w = max(1, min(width, round(width * factor)))
    top = rng.randint(0, height - crop_h)
    left = rng.randint(0, width - crop_w)
    window = (left, top, left + crop_w, top + crop_h)
    offset = np.array([left, top], dtype=np.float32)

    keep = _inside(sample.boxes, window)
    teacher_keep = _inside(sample.teacher_boxes, window)
    return Sample(
        image=sample.image[top : top + crop_h, left : left + crop_w].copy(),
        boxes=sample.boxes[keep] - np.tile(offset, 2),
        landmarks=sample.landmarks[keep] - offset,
        has_landmarks=sample.has_landmarks[keep],
        teacher_boxes=sample.teacher_boxes[teacher_keep] - np.tile(offset, 2),
        teacher_scores=sample.teacher_scores[teacher_keep],
        teacher_landmarks=sample.teacher_landmarks[teacher_keep] - offset,
    )


def drop_small_faces(sample: Sample, min_px: float = MIN_FACE_PX) -> Sample:
    """Remove faces below one cell of the finest level, at the input's own scale.

    Called after the letterbox so the threshold is in the pixels the network
    actually sees, which is the only frame where "too small to regress" means
    anything.
    """

    def large_enough(boxes: np.ndarray) -> np.ndarray:
        if not len(boxes):
            return np.zeros(0, dtype=bool)
        sides = np.sqrt(
            np.clip(boxes[:, 2] - boxes[:, 0], 0, None)
            * np.clip(boxes[:, 3] - boxes[:, 1], 0, None)
        )
        return sides >= min_px

    keep = large_enough(sample.boxes)
    teacher_keep = large_enough(sample.teacher_boxes)
    return Sample(
        image=sample.image,
        boxes=sample.boxes[keep],
        landmarks=sample.landmarks[keep],
        has_landmarks=sample.has_landmarks[keep],
        teacher_boxes=sample.teacher_boxes[teacher_keep],
        teacher_scores=sample.teacher_scores[teacher_keep],
        teacher_landmarks=sample.teacher_landmarks[teacher_keep],
    )


def horizontal_flip(sample: Sample) -> Sample:
    """Mirror the image, the boxes and both sets of landmarks.

    Landmarks are also reordered. Leaving the order alone labels the mirrored
    right eye as the left eye, which trains the head on contradictory targets
    while the loss keeps falling.
    """
    width = sample.image.shape[1]

    def flip_boxes(boxes: np.ndarray) -> np.ndarray:
        if not len(boxes):
            return boxes
        out = boxes.copy()
        out[:, 0], out[:, 2] = width - boxes[:, 2], width - boxes[:, 0]
        return out

    def flip_points(points: np.ndarray) -> np.ndarray:
        if not len(points):
            return points
        out = points[:, FLIP_INDEX, :].copy()
        out[..., 0] = width - out[..., 0]
        return out

    return Sample(
        image=sample.image[:, ::-1].copy(),
        boxes=flip_boxes(sample.boxes),
        landmarks=flip_points(sample.landmarks),
        has_landmarks=sample.has_landmarks,
        teacher_boxes=flip_boxes(sample.teacher_boxes),
        teacher_scores=sample.teacher_scores,
        teacher_landmarks=flip_points(sample.teacher_landmarks),
    )


def assign_priors(
    boxes: np.ndarray, priors: torch.Tensor, ranges: Sequence[tuple[float, float]] = LEVEL_RANGES
) -> tuple[torch.Tensor, torch.Tensor]:
    """Pick the prior of each face, and say which face every prior serves.

    A prior qualifies when its centre sits inside the box, near the box centre,
    and its level covers that face's size. Ties go to the smaller face, so a big
    box cannot swallow the priors a small one needs.
    """
    count = priors.shape[0]
    owner = torch.full((count,), -1, dtype=torch.long)
    if not len(boxes):
        return owner, torch.zeros(count, dtype=torch.bool)

    faces = torch.as_tensor(boxes, dtype=torch.float32)
    centres = priors[:, :2] + priors[:, 2:] / 2
    strides = priors[:, 2]
    sizes = ((faces[:, 2] - faces[:, 0]) * (faces[:, 3] - faces[:, 1])).clamp_min(1).sqrt()

    level_of = torch.zeros(count, dtype=torch.long)
    for index, stride in enumerate(sorted({float(s) for s in strides})):
        level_of[strides == stride] = index

    # Largest first, so a smaller face later overwrites and keeps its priors.
    for face in sizes.argsort(descending=True).tolist():
        size = float(sizes[face])
        level = next(i for i, (low, high) in enumerate(ranges) if low <= size < high)
        box = faces[face]
        centre = (box[:2] + box[2:]) / 2
        radius = strides * CENTER_RADIUS
        inside = (
            (centres[:, 0] > box[0])
            & (centres[:, 0] < box[2])
            & (centres[:, 1] > box[1])
            & (centres[:, 1] < box[3])
        )
        near = ((centres - centre).abs() < radius[:, None]).all(dim=1)
        owner[inside & near & (level_of == level)] = face

    return owner, owner >= 0


def assign_soft_targets(
    boxes: np.ndarray, scores: np.ndarray, landmarks: np.ndarray, priors: torch.Tensor
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """One image's teacher detections resampled onto the student's own priors.

    The two networks regress from different priors, so a teacher offset means
    nothing to the student head; only the pixel box survives the move and it is
    re-encoded here against the prior the student would use for it.

    A prior no teacher box claims is background at TEACHER_BACKGROUND_LOGIT, not
    at whatever the teacher scored there: only detections above the teacher's own
    confidence cut are kept, so what it thinks below that cut is never recorded.
    """
    count = priors.shape[0]
    cls = torch.full((count, 1), TEACHER_BACKGROUND_LOGIT)
    bbox = torch.zeros(count, 4)
    kps = torch.zeros(count, LANDMARK_COUNT * 2)

    owner, positive = assign_priors(boxes, priors)
    if positive.any():
        chosen = owner[positive]
        found = torch.as_tensor(boxes, dtype=torch.float32)[chosen]
        confidence = torch.as_tensor(scores, dtype=torch.float32)[chosen]
        points = torch.as_tensor(landmarks, dtype=torch.float32)[chosen]
        clamped = confidence.clamp(TEACHER_SCORE_EPS, 1 - TEACHER_SCORE_EPS)
        cls[positive] = torch.logit(clamped)[:, None]
        bbox[positive] = bbox_encode(priors[positive], found)
        kps[positive] = kps_encode(priors[positive], points.reshape(len(chosen), -1))
    return cls, bbox, kps


def teacher_targets(
    sample: Sample, priors: torch.Tensor
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """The soft targets a sample carries, on the priors, after its augmentation."""
    return assign_soft_targets(
        sample.teacher_boxes, sample.teacher_scores, sample.teacher_landmarks, priors
    )


def build_targets(sample: Sample, priors: torch.Tensor) -> DetectionTargets:
    """Turn one augmented sample into the per-prior tensors the loss reads."""
    owner, positive = assign_priors(sample.boxes, priors)
    count = priors.shape[0]

    boxes = torch.zeros(count, 4)
    landmarks = torch.zeros(count, LANDMARK_COUNT * 2)
    landmark_mask = torch.zeros(count, dtype=torch.bool)
    if positive.any():
        chosen = owner[positive]
        boxes[positive] = torch.as_tensor(sample.boxes, dtype=torch.float32)[chosen]
        points = torch.as_tensor(sample.landmarks, dtype=torch.float32)[chosen]
        landmarks[positive] = points.reshape(len(chosen), -1)
        landmark_mask[positive] = torch.as_tensor(sample.has_landmarks, dtype=torch.bool)[chosen]

    teacher_cls, teacher_bbox, teacher_kps = (
        teacher_targets(sample, priors) if len(sample.teacher_scores) else (None, None, None)
    )
    return DetectionTargets(
        labels=positive.long(),
        boxes=boxes,
        landmarks=landmarks,
        landmark_mask=landmark_mask,
        priors=priors,
        gt_boxes=[torch.as_tensor(sample.boxes, dtype=torch.float32)],
        teacher_cls=teacher_cls,
        teacher_bbox=teacher_bbox,
        teacher_kps=teacher_kps,
    )


@DATASETS.register("widerface")
class WiderFaceDataset(Dataset):
    """WIDER FACE through the committed split, with optional teacher targets."""

    def __init__(
        self,
        coco: Path,
        images_root: Path,
        split_file: Path,
        input_hw: tuple[int, int],
        train: bool = True,
        soft_targets: object | None = None,
        seed: int = 42,
        crop_scale: tuple[float, float] = CROP_SCALE,
        min_face_px: float = MIN_FACE_PX,
    ) -> None:
        payload = json.loads(Path(coco).read_text(encoding="utf-8"))
        listed = {
            line.strip()
            for line in Path(split_file).read_text(encoding="utf-8").splitlines()
            if line.strip()
        }
        by_image: dict[int, list[dict]] = {}
        for annotation in payload["annotations"]:
            by_image.setdefault(annotation["image_id"], []).append(annotation)

        self.records = [
            (image["file_name"], by_image.get(image["id"], []))
            for image in payload["images"]
            if image["file_name"] in listed
        ]
        self.images_root = Path(images_root)
        self.input_hw = tuple(input_hw)
        self.train = train
        self.soft_targets = soft_targets
        self.crop_scale = tuple(crop_scale)
        self.min_face_px = float(min_face_px)
        self.rng = random.Random(seed)
        self.priors = torch.cat(pyramid_priors(feature_sizes(self.input_hw, STRIDES), STRIDES))

    def __len__(self) -> int:
        return len(self.records)

    def _read(self, index: int) -> Sample:
        name, annotations = self.records[index]
        image = np.asarray(Image.open(self.images_root / name).convert("RGB"), dtype=np.uint8)

        boxes, landmarks, labelled = [], [], []
        for annotation in annotations:
            x, y, w, h = annotation["bbox"]
            boxes.append([x, y, x + w, y + h])
            points = np.asarray(annotation.get("keypoints") or [0.0] * 15, dtype=np.float32)
            landmarks.append(points.reshape(LANDMARK_COUNT, 3)[:, :2])
            labelled.append(annotation.get("num_keypoints", 0) > 0)

        sample = Sample(
            image=image,
            boxes=np.asarray(boxes, dtype=np.float32).reshape(-1, 4),
            landmarks=np.asarray(landmarks, dtype=np.float32).reshape(-1, LANDMARK_COUNT, 2),
            has_landmarks=np.asarray(labelled, dtype=bool).reshape(-1),
        )
        if self.soft_targets is not None and name in self.soft_targets:
            cached = self.soft_targets[name]
            sample.teacher_boxes = cached.boxes
            sample.teacher_scores = cached.scores
            sample.teacher_landmarks = cached.keypoints
        return sample

    def __getitem__(self, index: int) -> tuple[torch.Tensor, DetectionTargets]:
        sample = self._read(index)
        if self.train:
            sample = random_crop(sample, self.rng, self.crop_scale)
        # Filtered on both sides of the split: a face too small to train on is
        # also one this branch does not claim to find.
        sample = drop_small_faces(letterbox(sample, self.input_hw), self.min_face_px)
        if self.train and self.rng.random() < 0.5:
            sample = horizontal_flip(sample)

        image = torch.from_numpy(sample.image).permute(2, 0, 1).float() / 255.0
        return image, build_targets(sample, self.priors)


def collate(batch: list[tuple[torch.Tensor, DetectionTargets]]) -> tuple[torch.Tensor, ...]:
    """Stack images and per-prior targets, keeping raw boxes as a per-image list."""
    images = torch.stack([item[0] for item in batch])
    targets = [item[1] for item in batch]

    def stack_teacher(field_name: str) -> torch.Tensor | None:
        """Absent on the baseline arm, and present on every sample or none."""
        values = [getattr(t, field_name) for t in targets]
        return None if any(v is None for v in values) else torch.stack(values)

    merged = DetectionTargets(
        labels=torch.stack([t.labels for t in targets]),
        boxes=torch.stack([t.boxes for t in targets]),
        landmarks=torch.stack([t.landmarks for t in targets]),
        landmark_mask=torch.stack([t.landmark_mask for t in targets]),
        priors=targets[0].priors,
        gt_boxes=[t.gt_boxes[0] for t in targets],
        teacher_cls=stack_teacher("teacher_cls"),
        teacher_bbox=stack_teacher("teacher_bbox"),
        teacher_kps=stack_teacher("teacher_kps"),
    )
    return images, merged


def encoded_boxes(targets: DetectionTargets) -> torch.Tensor:
    """Regression targets in the head's own space, for tests and diagnostics."""
    return bbox_encode(targets.priors, targets.boxes)
