"""WIDER FACE plus RetinaFace landmarks to COCO json.

The RetinaFace label file is the source of truth for both boxes and the five
landmarks: every branch that reads this file must see identical targets, or a
landmark head learns against a different frame than the task loss.
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

NUM_LANDMARKS = 5
LANDMARK_NAMES = ("left_eye", "right_eye", "nose", "left_mouth", "right_mouth")
MISSING = -1.0

# A landmark row holds x, y and confidence per point; -1 marks an unannotated
# face, which must stay out of the landmark loss.
LANDMARK_STRIDE = 3
BOX_FIELDS = 4


@dataclass
class Face:
    """One annotated face in image coordinates."""

    box_xywh: tuple[float, float, float, float]
    landmarks: list[tuple[float, float]] = field(default_factory=list)
    has_landmarks: bool = False
    blur: int = 0
    invalid: bool = False


@dataclass
class Sample:
    relative_path: str
    faces: list[Face]


def parse_label_file(path: Path) -> Iterator[Sample]:
    """Read a RetinaFace label.txt into samples.

    The format is a `# <relative path>` line followed by one line per face.
    """
    current: str | None = None
    faces: list[Face] = []
    with path.open(encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line:
                continue
            if line.startswith("#"):
                if current is not None:
                    yield Sample(current, faces)
                current = line[1:].strip()
                faces = []
                continue
            face = _parse_face(line)
            if face is not None:
                faces.append(face)
    if current is not None:
        yield Sample(current, faces)


def _parse_face(line: str) -> Face | None:
    parts = line.split()
    if len(parts) < BOX_FIELDS:
        return None
    x, y, w, h = (float(v) for v in parts[:BOX_FIELDS])
    if w <= 0 or h <= 0:
        return None

    landmarks: list[tuple[float, float]] = []
    has_landmarks = False
    tail = parts[BOX_FIELDS:]
    if len(tail) >= NUM_LANDMARKS * LANDMARK_STRIDE:
        points = [
            (float(tail[i * LANDMARK_STRIDE]), float(tail[i * LANDMARK_STRIDE + 1]))
            for i in range(NUM_LANDMARKS)
        ]
        has_landmarks = all(px >= 0 and py >= 0 for px, py in points)
        landmarks = points if has_landmarks else [(MISSING, MISSING)] * NUM_LANDMARKS
    else:
        landmarks = [(MISSING, MISSING)] * NUM_LANDMARKS

    return Face(box_xywh=(x, y, w, h), landmarks=landmarks, has_landmarks=has_landmarks)


def image_size(path: Path) -> tuple[int, int]:
    """Width and height, read from the header rather than by decoding pixels."""
    from PIL import Image

    with Image.open(path) as image:
        return image.width, image.height


def build_coco(
    labels: Path, images_root: Path, min_side_pixels: float = 0.0, require_images: bool = True
) -> dict:
    """Turn a label file into a COCO dict with a five-keypoint category."""
    coco: dict = {
        "info": {"description": "WIDER FACE with RetinaFace five-point landmarks"},
        "licenses": [{"id": 1, "name": "research-only"}],
        "images": [],
        "annotations": [],
        "categories": [
            {
                "id": 1,
                "name": "face",
                "keypoints": list(LANDMARK_NAMES),
                "skeleton": [],
            }
        ],
    }

    image_id = 0
    annotation_id = 0
    skipped_images = 0
    skipped_faces = 0
    with_landmarks = 0

    for sample in parse_label_file(labels):
        path = images_root / sample.relative_path
        if not path.is_file():
            skipped_images += 1
            if require_images:
                continue
            width = height = 0
        else:
            width, height = image_size(path)

        image_id += 1
        coco["images"].append(
            {
                "id": image_id,
                "file_name": sample.relative_path,
                "width": width,
                "height": height,
            }
        )

        for face in sample.faces:
            x, y, w, h = face.box_xywh
            if min(w, h) < min_side_pixels:
                skipped_faces += 1
                continue
            annotation_id += 1
            keypoints: list[float] = []
            for px, py in face.landmarks:
                visible = 2 if face.has_landmarks else 0
                keypoints.extend([px, py, float(visible)])
            if face.has_landmarks:
                with_landmarks += 1
            coco["annotations"].append(
                {
                    "id": annotation_id,
                    "image_id": image_id,
                    "category_id": 1,
                    "bbox": [x, y, w, h],
                    "area": w * h,
                    "iscrowd": 0,
                    "num_keypoints": NUM_LANDMARKS if face.has_landmarks else 0,
                    "keypoints": keypoints,
                }
            )

    coco["info"].update(
        {
            "num_images": len(coco["images"]),
            "num_faces": len(coco["annotations"]),
            "num_faces_with_landmarks": with_landmarks,
            "skipped_images_absent": skipped_images,
            "skipped_faces_small": skipped_faces,
        }
    )
    return coco


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", type=Path, required=True)
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--min-side-pixels", type=float, default=0.0)
    parser.add_argument("--allow-absent-images", action="store_true")
    args = parser.parse_args(argv)

    coco = build_coco(
        args.labels,
        args.images,
        min_side_pixels=args.min_side_pixels,
        require_images=not args.allow_absent_images,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(coco), encoding="utf-8")

    info = coco["info"]
    print(
        f"{args.out}: {info['num_images']} images, {info['num_faces']} faces, "
        f"{info['num_faces_with_landmarks']} with landmarks"
    )
    if info["skipped_images_absent"]:
        print(f"  {info['skipped_images_absent']} image(s) named in the labels are absent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
