"""CelebA-Spoof parquet shards to face crops at two scales.

MiniFASNet trains on two views of the same face: a tight 1.0x crop and a 2.7x
context crop. The wide crop carries what separates a live face from a photo of
one, the screen bezel and the paper edge, so cropping tight only throws away the
signal the branch depends on.

The mirror stores three columns: the encoded image, a bounding box and a class.
Boxes are absolute pixel [x1, y1, x2, y2] in the image's own frame, verified
against image dimensions across sample rows.

Usage:
    python -m facepipe.data.prepare.celeba_spoof_parquet \\
        --root data/raw/antispoof/celeba_spoof \\
        --out data/interim/antispoof/celeba_spoof_crops
"""

from __future__ import annotations

import argparse
import io
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

CROP_SCALES = (1.0, 2.7)
CROP_SIZE = 128
IMAGE_COLUMN = "Filepath"
BBOX_COLUMN = "Bbox"
CLASS_COLUMN = "Class"
SPLIT_PREFIXES = ("train", "valid", "test")


@dataclass
class Sample:
    """One row: encoded image, box in pixels, and whether it is an attack."""

    name: str
    image_bytes: bytes
    box_xyxy: tuple[int, int, int, int]
    is_spoof: bool
    split: str


def split_of(path: Path) -> str:
    """Take the upstream split from the shard filename.

    The mirror keeps CelebA-Spoof's official train/valid/test division. Identity
    labels are absent from the mirror, so this split is the only guarantee of
    identity separation available and must not be reshuffled.
    """
    stem = path.name.split("-", 1)[0]
    return stem if stem in SPLIT_PREFIXES else "unknown"


def shard_paths(root: Path) -> list[Path]:
    return sorted((root / "data").glob("*.parquet"))


def read_shard(path: Path) -> Iterator[Sample]:
    """Stream one parquet shard row by row."""
    import pyarrow.parquet as pq

    split = split_of(path)
    handle = pq.ParquetFile(path)
    for group in range(handle.num_row_groups):
        for row in handle.read_row_group(group).to_pylist():
            box = row.get(BBOX_COLUMN)
            image = row.get(IMAGE_COLUMN) or {}
            if not box or len(box) != 4 or not image.get("bytes"):
                continue
            yield Sample(
                name=Path(image.get("path") or f"{group}.png").stem,
                image_bytes=image["bytes"],
                box_xyxy=(int(box[0]), int(box[1]), int(box[2]), int(box[3])),
                is_spoof=str(row.get(CLASS_COLUMN, "")).lower() == "spoof",
                split=split,
            )


def scaled_box(
    box_xyxy: tuple[int, int, int, int], scale: float, width: int, height: int
) -> tuple[int, int, int, int]:
    """Grow a box about its centre, square it off, and clamp to the image.

    Squaring before scaling keeps the aspect ratio constant, so a wide box and a
    tall box of the same face produce the same crop.
    """
    x1, y1, x2, y2 = box_xyxy
    cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
    side = max(x2 - x1, y2 - y1) * scale
    left, top = round(cx - side / 2.0), round(cy - side / 2.0)
    right, bottom = round(cx + side / 2.0), round(cy + side / 2.0)
    return (
        max(0, left),
        max(0, top),
        min(width, max(left + 1, right)),
        min(height, max(top + 1, bottom)),
    )


def crop_sample(sample: Sample, out_root: Path, size: int = CROP_SIZE) -> list[Path]:
    """Write one crop per scale under <scale>/<split>/<label>/."""
    from PIL import Image

    written: list[Path] = []
    with Image.open(io.BytesIO(sample.image_bytes)) as image:
        image = image.convert("RGB")
        label = "spoof" if sample.is_spoof else "live"
        for scale in CROP_SCALES:
            box = scaled_box(sample.box_xyxy, scale, image.width, image.height)
            patch = image.crop(box).resize((size, size), Image.BILINEAR)
            target = out_root / f"img_{scale:g}x" / sample.split / label / f"{sample.name}.jpg"
            target.parent.mkdir(parents=True, exist_ok=True)
            patch.save(target, quality=95)
            written.append(target)
    return written


def run(root: Path, out_root: Path, size: int = CROP_SIZE, limit: int | None = None) -> dict:
    """Crop every annotated face in every shard."""
    stats = {"cropped": 0, "skipped": 0, "live": 0, "spoof": 0, "shards": 0}
    done = 0
    for shard in shard_paths(root):
        stats["shards"] += 1
        for sample in read_shard(shard):
            if limit is not None and done >= limit:
                return stats
            try:
                crop_sample(sample, out_root, size)
            except OSError:
                stats["skipped"] += 1
                continue
            stats["cropped"] += 1
            stats["spoof" if sample.is_spoof else "live"] += 1
            done += 1
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
        f"{args.out}: {stats['cropped']} face(s) from {stats['shards']} shard(s) "
        f"({stats['live']} live, {stats['spoof']} spoof), {stats['skipped']} undecodable"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
