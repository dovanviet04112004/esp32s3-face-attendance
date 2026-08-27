"""CelebA-Spoof to face crops at two scales.

MiniFASNet is trained on two views of the same face: a tight 1.0x crop and a
2.7x context crop. The wide crop is what carries the cues that separate a live
face from a photo of one, the screen bezel and the paper edge, so cropping
tight only would throw away the signal the branch depends on.

Usage:
    python -m facepipe.data.prepare.celeba_spoof_crop \\
        --root data/raw/antispoof/celeba_spoof \\
        --out data/interim/antispoof/celeba_spoof_crops
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

CROP_SCALES = (1.0, 2.7)
CROP_SIZE = 128
LIVE = 0
SPOOF = 1


@dataclass
class Annotation:
    """One labelled face: path, box in pixels, and whether it is an attack."""

    relative_path: str
    box_xywh: tuple[float, float, float, float]
    is_spoof: bool
    spoof_type: int | None = None


def scaled_box(
    box: tuple[float, float, float, float],
    scale: float,
    width: int,
    height: int,
) -> tuple[int, int, int, int]:
    """Grow a box about its centre, square it off, and clamp to the image.

    Squaring before scaling keeps the aspect ratio the network sees constant,
    so a wide box and a tall box of the same face produce the same crop.
    """
    x, y, w, h = box
    cx, cy = x + w / 2.0, y + h / 2.0
    side = max(w, h) * scale
    left = round(cx - side / 2.0)
    top = round(cy - side / 2.0)
    right = round(cx + side / 2.0)
    bottom = round(cy + side / 2.0)
    return (
        max(0, left),
        max(0, top),
        min(width, max(left + 1, right)),
        min(height, max(top + 1, bottom)),
    )


def read_annotations(root: Path) -> Iterator[Annotation]:
    """Read the bbox and label files CelebA-Spoof ships with.

    Boxes are stored relative to a 224-pixel reference, which is why the real
    image size has to be read before they mean anything in pixels.
    """
    bbox_file = root / "metas" / "intra_test" / "bbox.json"
    label_file = root / "metas" / "intra_test" / "label.json"
    if not bbox_file.is_file() or not label_file.is_file():
        raise FileNotFoundError(
            f"expected {bbox_file} and {label_file}; check the CelebA-Spoof layout"
        )
    boxes = json.loads(bbox_file.read_text(encoding="utf-8"))
    labels = json.loads(label_file.read_text(encoding="utf-8"))
    for relative, box in boxes.items():
        label = labels.get(relative)
        if label is None:
            continue
        yield Annotation(
            relative_path=relative,
            box_xywh=(float(box[0]), float(box[1]), float(box[2]), float(box[3])),
            is_spoof=bool(label[43]) if isinstance(label, list) else bool(label),
            spoof_type=label[40] if isinstance(label, list) and len(label) > 40 else None,
        )


def crop_one(
    image_path: Path, annotation: Annotation, out_root: Path, size: int = CROP_SIZE
) -> list[Path]:
    """Write one crop per scale, mirroring the source path under each scale directory."""
    from PIL import Image

    written: list[Path] = []
    with Image.open(image_path) as image:
        image = image.convert("RGB")
        reference = 224.0
        sx, sy = image.width / reference, image.height / reference
        x, y, w, h = annotation.box_xywh
        box_px = (x * sx, y * sy, w * sx, h * sy)

        for scale in CROP_SCALES:
            left, top, right, bottom = scaled_box(box_px, scale, image.width, image.height)
            patch = image.crop((left, top, right, bottom)).resize((size, size), Image.BILINEAR)
            label = "spoof" if annotation.is_spoof else "live"
            target = out_root / f"img_{scale:g}x" / label / annotation.relative_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target = target.with_suffix(".jpg")
            patch.save(target, quality=95)
            written.append(target)
    return written


def run(root: Path, out_root: Path, size: int = CROP_SIZE, limit: int | None = None) -> dict:
    """Crop every annotated face, skipping images that are absent."""
    stats = {"cropped": 0, "missing": 0, "live": 0, "spoof": 0}
    for index, annotation in enumerate(read_annotations(root)):
        if limit is not None and index >= limit:
            break
        image_path = root / annotation.relative_path
        if not image_path.is_file():
            stats["missing"] += 1
            continue
        crop_one(image_path, annotation, out_root, size)
        stats["cropped"] += 1
        stats["spoof" if annotation.is_spoof else "live"] += 1
    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--size", type=int, default=CROP_SIZE)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args(argv)

    stats = run(args.root, args.out, args.size, args.limit)
    print(
        f"{args.out}: {stats['cropped']} face(s) "
        f"({stats['live']} live, {stats['spoof']} spoof), {stats['missing']} image(s) absent"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
