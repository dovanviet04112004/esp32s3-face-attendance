"""A smaller copy of a COCO dataset: images and coordinates rescaled together.

The student letterboxes to 160x120 and has no augmentation that ever asks for
more, so decoding a 1024x768 JPEG to produce it is work thrown away. Measured on
this branch: reading alone runs at 258 images a second and reading with the full
training step at 271, meaning the GPU spends the epoch waiting on JPEG decode.

Images and annotations are rescaled in the same pass on purpose. Two passes, or
a resize with the old labels left alone, produce a dataset that loads, trains,
and is wrong everywhere by one scale factor - boxes drawn slightly off every
face, with nothing that raises.

Usage:
    python -m facepipe.data.prepare.shrink_coco \\
        --coco data/interim/detection/widerface_coco/train.json \\
        --images data/raw/detection/widerface/WIDER_train/images \\
        --out-coco data/interim/detection/widerface_small/train.json \\
        --out-images data/interim/detection/widerface_small/images --max-side 320
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image

JPEG_QUALITY = 92
KEYPOINT_STRIDE = 3


def scale_for(width: int, height: int, max_side: int) -> float:
    """How much to shrink by, or 1.0 for an image already small enough."""
    longest = max(width, height)
    return max_side / longest if longest > max_side else 1.0


def scale_annotation(annotation: dict, scale: float) -> dict:
    """Multiply the box and every keypoint, leaving visibility flags alone.

    Keypoints are stored as x, y, visible triples: scaling the flag would turn
    "annotated" into a number no reader recognises.
    """
    scaled = dict(annotation)
    scaled["bbox"] = [value * scale for value in annotation["bbox"]]
    if annotation.get("area") is not None:
        scaled["area"] = annotation["area"] * scale * scale
    points = annotation.get("keypoints")
    if points:
        scaled["keypoints"] = [
            value if index % KEYPOINT_STRIDE == 2 else value * scale
            for index, value in enumerate(points)
        ]
    return scaled


def shrink(
    coco_path: Path,
    images_root: Path,
    out_coco: Path,
    out_images: Path,
    max_side: int,
    quality: int = JPEG_QUALITY,
) -> dict:
    """Write the smaller images and the matching COCO file, and report counts."""
    payload = json.loads(Path(coco_path).read_text(encoding="utf-8"))
    by_image: dict[int, list[dict]] = {}
    for annotation in payload["annotations"]:
        by_image.setdefault(annotation["image_id"], []).append(annotation)

    stats = {"images": 0, "resized": 0, "annotations": 0, "missing": 0}
    images: list[dict] = []
    annotations: list[dict] = []

    for record in payload["images"]:
        source = Path(images_root) / record["file_name"]
        if not source.is_file():
            stats["missing"] += 1
            continue

        target = Path(out_images) / record["file_name"]
        target.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(source) as handle:
            image = handle.convert("RGB")
            scale = scale_for(image.width, image.height, max_side)
            if scale < 1.0:
                size = (round(image.width * scale), round(image.height * scale))
                image = image.resize(size, Image.BILINEAR)
                stats["resized"] += 1
            image.save(target, format="JPEG", quality=quality)
            width, height = image.size

        images.append({**record, "width": width, "height": height})
        for annotation in by_image.get(record["id"], []):
            annotations.append(scale_annotation(annotation, scale))
            stats["annotations"] += 1
        stats["images"] += 1

    out_coco.parent.mkdir(parents=True, exist_ok=True)
    out_coco.write_text(
        json.dumps({**payload, "images": images, "annotations": annotations}), encoding="utf-8"
    )
    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--coco", type=Path, required=True)
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--out-coco", type=Path, required=True)
    parser.add_argument("--out-images", type=Path, required=True)
    parser.add_argument("--max-side", type=int, required=True)
    parser.add_argument("--quality", type=int, default=JPEG_QUALITY)
    args = parser.parse_args(argv)

    stats = shrink(
        args.coco, args.images, args.out_coco, args.out_images, args.max_side, args.quality
    )
    print(f"{args.out_coco}: {stats}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
