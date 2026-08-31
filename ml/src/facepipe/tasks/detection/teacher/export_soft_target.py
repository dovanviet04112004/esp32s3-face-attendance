"""Cache the teacher's detections once, in original image coordinates.

What is cached is geometry, not feature maps. Section 3.7 requires the four arms
to share one augmentation recipe, and detection trains under mosaic, which glues
four images together and crops the result. Boxes and landmarks survive that: they
are transformed alongside the real labels. A feature map cannot be, so feature
distillation needs the teacher in the loop and cannot read from here.

Storing detections rather than a dense per-prior map is what makes the cache
augmentable at all, and it is also two orders of magnitude smaller.

Usage:
    python -m facepipe.tasks.detection.teacher.export_soft_target \\
        --cfg configs/detection/teacher_yolo26m_pose.yaml \\
        --weights artifacts/detection/runs/<run_id>/ultralytics/weights/best.pt
"""

from __future__ import annotations

import argparse
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from torch import nn

from facepipe.core.config import load_config
from facepipe.core.registry import TEACHERS

from ..postproc.decode import unflatten_levels
from ..student.anchors import feature_sizes
from ..student.head import LANDMARK_COUNT, HeadOutput
from ..student.yunet import STRIDES

SHARD_SIZE = 2000
SHARD_STEM = "soft_target"
FORMAT_VER = 1


@dataclass
class SoftTarget:
    """One image's teacher detections, in that image's own pixel frame."""

    name: str
    boxes: np.ndarray
    scores: np.ndarray
    keypoints: np.ndarray

    def __post_init__(self) -> None:
        faces = len(self.boxes)
        if self.scores.shape != (faces,) or self.keypoints.shape != (faces, LANDMARK_COUNT, 2):
            raise ValueError(
                f"{self.name}: {faces} box(es) but scores {self.scores.shape} "
                f"and keypoints {self.keypoints.shape}"
            )


def shard_path(out_dir: Path, index: int) -> Path:
    return out_dir / f"{SHARD_STEM}_{index:05d}.npz"


def write_shard(targets: list[SoftTarget], path: Path) -> int:
    """Pack a run of images into one npz, concatenated with an offset index.

    One array per field beats one entry per image: npz stores each entry as its
    own deflate stream, and 2000 tiny streams cost more to open than to read.
    """
    offsets = np.zeros(len(targets) + 1, dtype=np.int64)
    for position, target in enumerate(targets):
        offsets[position + 1] = offsets[position] + len(target.boxes)

    empty_kps = np.zeros((0, LANDMARK_COUNT, 2), dtype=np.float32)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        path,
        format_ver=np.int32(FORMAT_VER),
        names=np.array([t.name for t in targets]),
        offsets=offsets,
        boxes=np.concatenate([t.boxes for t in targets] or [np.zeros((0, 4), np.float32)]),
        scores=np.concatenate([t.scores for t in targets] or [np.zeros((0,), np.float32)]),
        keypoints=np.concatenate([t.keypoints for t in targets] or [empty_kps]),
    )
    return int(offsets[-1])


def read_shard(path: Path) -> dict[str, SoftTarget]:
    """Unpack one shard back into per-image detections."""
    with np.load(path, allow_pickle=False) as payload:
        version = int(payload["format_ver"])
        if version != FORMAT_VER:
            raise ValueError(f"{path}: soft target format {version}, expected {FORMAT_VER}")
        names = [str(n) for n in payload["names"]]
        offsets = payload["offsets"]
        boxes, scores, keypoints = payload["boxes"], payload["scores"], payload["keypoints"]

    out: dict[str, SoftTarget] = {}
    for position, name in enumerate(names):
        start, stop = int(offsets[position]), int(offsets[position + 1])
        out[name] = SoftTarget(
            name=name,
            boxes=boxes[start:stop],
            scores=scores[start:stop],
            keypoints=keypoints[start:stop],
        )
    return out


def write_shards(
    targets: Iterable[SoftTarget], out_dir: Path, shard_size: int = SHARD_SIZE
) -> dict[str, int]:
    """Write every target, cutting a new shard each shard_size images."""
    out_dir.mkdir(parents=True, exist_ok=True)
    stats = {"images": 0, "faces": 0, "shards": 0}
    batch: list[SoftTarget] = []
    for target in targets:
        batch.append(target)
        if len(batch) == shard_size:
            stats["faces"] += write_shard(batch, shard_path(out_dir, stats["shards"]))
            stats["images"] += len(batch)
            stats["shards"] += 1
            batch = []
    if batch:
        stats["faces"] += write_shard(batch, shard_path(out_dir, stats["shards"]))
        stats["images"] += len(batch)
        stats["shards"] += 1
    return stats


class SoftTargetStore:
    """Read-side view over a directory of shards."""

    def __init__(self, root: Path) -> None:
        self.shards = sorted(Path(root).glob(f"{SHARD_STEM}_*.npz"))
        if not self.shards:
            raise FileNotFoundError(f"{root}: no soft target shards")
        self._cache: dict[Path, dict[str, SoftTarget]] = {}
        self._owner: dict[str, Path] = {}
        for shard in self.shards:
            with np.load(shard, allow_pickle=False) as payload:
                for name in payload["names"]:
                    self._owner[str(name)] = shard

    def __len__(self) -> int:
        return len(self._owner)

    def __contains__(self, name: object) -> bool:
        return name in self._owner

    def __getitem__(self, name: str) -> SoftTarget:
        shard = self._owner[name]
        if shard not in self._cache:
            self._cache[shard] = read_shard(shard)
        return self._cache[shard][name]


@TEACHERS.register("cached_head_output")
class CachedHeadOutput(nn.Module):
    """Stands in for the teacher once its answers sit on the student's priors.

    Running YOLO26m every step to re-derive answers that do not depend on the
    student would make the distilled arm cost several times the baseline it is
    compared against, and the table would then measure patience rather than
    method (KEHOACH section 3.7). The loader has already moved the cached
    detections through the same crop and flip the image took, so all that is
    left here is putting the rows back into head shape.
    """

    def __init__(self, input_hw: tuple[int, int] = (120, 160)) -> None:
        super().__init__()
        self.sizes = feature_sizes(tuple(input_hw), STRIDES)

    def forward(self, cached: tuple[torch.Tensor, torch.Tensor, torch.Tensor]) -> HeadOutput:
        cls, bbox, kps = cached
        return HeadOutput(
            cls=unflatten_levels(cls, self.sizes),
            bbox=unflatten_levels(bbox, self.sizes),
            kps=unflatten_levels(kps, self.sizes),
        )


def run_teacher(weights: Path, images: list[Path], imgsz: int, conf: float) -> Iterator[SoftTarget]:
    """Detect on every image, keeping results in that image's own frame."""
    from ..teacher.yolo26_pose_wrapper import Yolo26PoseTeacher

    teacher = Yolo26PoseTeacher(weights, conf=conf, imgsz=imgsz)
    for path in images:
        result = teacher.detector.predict(str(path), conf=conf, imgsz=imgsz, verbose=False)[0]
        yield SoftTarget(
            name=path.name,
            boxes=result.boxes.xyxy.cpu().numpy().astype(np.float32),
            scores=result.boxes.conf.cpu().numpy().astype(np.float32),
            keypoints=result.keypoints.xy.cpu().numpy().astype(np.float32),
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cfg", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--split", default="train", choices=("train", "val"))
    parser.add_argument("--out", type=Path)
    parser.add_argument("--shard-size", type=int, default=SHARD_SIZE)
    args = parser.parse_args(argv)

    cfg = load_config(args.cfg)
    dataset = Path(cfg.teacher.params["yolo_dataset"])
    images = sorted((dataset / "images" / args.split).glob("*.jpg"))
    out = args.out or dataset.parent / "widerface_soft_target" / args.split

    stats = write_shards(
        run_teacher(
            args.weights, images, cfg.teacher.input_hw[1], float(cfg.teacher.params["conf"])
        ),
        out,
        args.shard_size,
    )
    print(
        f"{out}: {stats['images']} image(s), {stats['faces']} face(s), {stats['shards']} shard(s)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
