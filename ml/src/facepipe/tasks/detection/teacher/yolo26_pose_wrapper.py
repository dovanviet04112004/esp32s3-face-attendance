"""YOLO26m-pose behind the interface the rest of the branch expects.

Ultralytics is AGPL-3.0 and only this module touches it, so the import stays
local. The pretrained checkpoint predicts 17 COCO body keypoints; using it
unchanged would distil shoulders into a head that means eyes and mouth corners,
and nothing downstream would complain, so load() checks.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import torch
from torch import nn
from torch.nn.functional import interpolate

from facepipe.core.registry import TEACHERS

from ..postproc.decode import unflatten_levels
from ..student.anchors import feature_sizes
from ..student.head import LANDMARK_COUNT, HeadOutput
from ..student.yunet import STRIDES

FACE_KPT_SHAPE = (LANDMARK_COUNT, 3)


@dataclass
class TeacherDetections:
    """Per-image detections in pixels, ordered by descending score."""

    boxes: list[torch.Tensor]
    scores: list[torch.Tensor]
    keypoints: list[torch.Tensor]

    def __len__(self) -> int:
        return len(self.boxes)


def check_face_head(kpt_shape: tuple[int, ...], num_classes: int) -> None:
    """Reject a checkpoint that still has the COCO person head."""
    points = next(iter(kpt_shape))
    if points != LANDMARK_COUNT:
        raise ValueError(
            f"teacher predicts {points} keypoints, not {LANDMARK_COUNT}. "
            "Fine-tune on WIDER FACE first (finetune_widerface.py)"
        )
    if num_classes != 1:
        raise ValueError(f"teacher has {num_classes} classes, expected 1 (face)")


@TEACHERS.register("yolo26_pose")
class Yolo26PoseTeacher(nn.Module):
    """Frozen detector producing boxes and five landmarks.

    Kept in eval mode on every train() call, matching core's TeacherWrapper: an
    outer model.train() would otherwise put batch-norm back into update mode and
    let the soft targets drift mid-run.
    """

    def __init__(
        self,
        weights: str | Path,
        conf: float = 0.25,
        iou: float = 0.5,
        imgsz: int = 640,
        strict: bool = True,
    ) -> None:
        super().__init__()
        from ultralytics import YOLO

        self.detector = YOLO(str(weights))
        self.conf = conf
        self.iou = iou
        self.imgsz = imgsz
        if strict:
            check_face_head(self.detector.model.kpt_shape, len(self.detector.model.names))
        for param in self.detector.model.parameters():
            param.requires_grad_(False)
        self.detector.model.eval()

    def train(self, mode: bool = True) -> Yolo26PoseTeacher:
        super().train(mode)
        self.detector.model.eval()
        return self

    @torch.no_grad()
    def forward(self, images: torch.Tensor) -> TeacherDetections:
        results = self.detector.predict(
            images, conf=self.conf, iou=self.iou, imgsz=self.imgsz, verbose=False
        )
        boxes, scores, keypoints = [], [], []
        for result in results:
            boxes.append(result.boxes.xyxy)
            scores.append(result.boxes.conf)
            keypoints.append(result.keypoints.xy)
        return TeacherDetections(boxes=boxes, scores=scores, keypoints=keypoints)


@TEACHERS.register("yolo26_pose_on_priors")
class PriorAssignedTeacher(nn.Module):
    """The detector, with its answers put into the student's head shape.

    Feature distillation needs maps from the same forward the soft targets came
    from, so the detector runs inside the loop (KEHOACH 3.7). It sees the
    student's letterboxed frame upscaled, never the original.
    """

    def __init__(
        self,
        weights: str | Path | None = None,
        upscale: int = 4,
        input_hw: tuple[int, int] = (120, 160),
        detector: nn.Module | None = None,
        **kwargs: object,
    ) -> None:
        super().__init__()
        self.detector = detector or Yolo26PoseTeacher(weights, **kwargs)
        self.upscale = upscale
        self.sizes = feature_sizes(tuple(input_hw), STRIDES)

    @torch.no_grad()
    def forward(self, batch: tuple[torch.Tensor, torch.Tensor]) -> HeadOutput:
        from ..data import assign_soft_targets

        images, priors = batch
        larger = interpolate(images.float(), scale_factor=self.upscale, mode="bilinear")
        found = self.detector(larger)

        on_priors = [
            assign_soft_targets(
                (box / self.upscale).detach().cpu().numpy(),
                score.detach().cpu().numpy(),
                (points / self.upscale).detach().cpu().numpy(),
                priors.detach().cpu(),
            )
            for box, score, points in zip(found.boxes, found.scores, found.keypoints, strict=True)
        ]
        stacked = [torch.stack(rows).to(images.device) for rows in zip(*on_priors, strict=True)]
        return HeadOutput(*(unflatten_levels(part, self.sizes) for part in stacked))
