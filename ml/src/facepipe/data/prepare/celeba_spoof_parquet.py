"""CelebA-Spoof parquet shards to face crops at two scales, packed into shards.

MiniFASNet trains on two views of the same face: a tight 1.0x crop and a context
crop reaching for 2.7x. The wide crop carries what separates a live face from a
photo of one, the screen bezel and the paper edge. 2.7x is a cap rather than a
constant, since a face near the camera leaves no room for it (KEHOACH §3).

Both scales go in one record, so an epoch over 419,935 faces costs that many
reads rather than twice as many opens (KEHOACH section 4.4.1).

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
import json
import os
from collections.abc import Iterator
from dataclasses import dataclass
from itertools import batched
from multiprocessing import Pool
from pathlib import Path

from .images_to_wds import ShardWriter

CROP_SCALES = {"tight": 1.0, "wide": 2.7}
CROP_SIZE = 128
# Holds 80 px of face at the 2.7x ceiling, so recropping the context view down
# to 1.0x at read time still fills the model input (KEHOACH §3, layer 2).
WIDE_SIZE = 224
CROP_QUALITY = 95
# Bounds how many undecoded source images are in flight across the pool at once.
ENCODE_BATCH = 256
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


def fitted_box(
    box_xyxy: tuple[int, int, int, int], scale: float, width: int, height: int
) -> tuple[tuple[int, int, int, int], float]:
    """Largest square that fits the frame, capped at `scale`, slid to hold the face.

    Returns the box and the scale it actually reached, which falls below `scale`
    whenever the face sits too near the camera. Stretching a clamped rectangle
    back to square distorts the face and padding invents context, and both read
    as attack cues (KEHOACH §3).
    """
    x1, y1, x2, y2 = box_xyxy
    cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
    face = max(1, max(x2 - x1, y2 - y1))
    side = max(1, int(min(face * scale, width, height)))
    left = min(max(0, round(cx - side / 2.0)), width - side)
    top = min(max(0, round(cy - side / 2.0)), height - side)
    return (left, top, left + side, top + side), side / face


def crop_sizes(size: int = CROP_SIZE, wide_size: int = WIDE_SIZE) -> dict[str, int]:
    return {name: wide_size if name == "wide" else size for name in CROP_SCALES}


def face_within(box_xyxy: tuple[int, int, int, int], crop: tuple[int, int, int, int]):
    """The face box in crop-relative units, which is what recropping needs."""
    x1, y1, x2, y2 = box_xyxy
    left, top, right, _ = crop
    side = max(1, right - left)
    return [
        round((x1 - left) / side, 4),
        round((y1 - top) / side, 4),
        round((x2 - left) / side, 4),
        round((y2 - top) / side, 4),
    ]


def encode_crops(
    sample: Sample, size: int = CROP_SIZE, wide_size: int = WIDE_SIZE
) -> dict[str, bytes]:
    """Both scales of one face plus its label, as the members of one record."""
    from PIL import Image

    members: dict[str, bytes] = {}
    reached: dict[str, float] = {}
    sizes = crop_sizes(size, wide_size)
    face_in_wide: list[float] = []
    with Image.open(io.BytesIO(sample.image_bytes)) as image:
        image = image.convert("RGB")
        for name, scale in CROP_SCALES.items():
            box, reached[name] = fitted_box(sample.box_xyxy, scale, image.width, image.height)
            if name == "wide":
                face_in_wide = face_within(sample.box_xyxy, box)
            edge = sizes[name]
            patch = image.crop(box).resize((edge, edge), Image.BILINEAR)
            buffer = io.BytesIO()
            patch.save(buffer, format="JPEG", quality=CROP_QUALITY)
            members[f"{name}.jpg"] = buffer.getvalue()

    meta = {
        "name": sample.name,
        "label": int(sample.is_spoof),
        "split": sample.split,
        "wide_scale": round(reached["wide"], 4),
        "face_in_wide": face_in_wide,
    }
    members["json"] = json.dumps(meta).encode()
    return members


def _encode_task(payload: tuple[Sample, int, int]) -> dict[str, bytes] | None:
    sample, size, wide_size = payload
    try:
        return encode_crops(sample, size, wide_size)
    except OSError:
        return None


def iter_samples(root: Path, stats: dict, limit: int | None) -> Iterator[Sample]:
    """Stream every annotated row of every parquet shard, stopping at limit."""
    done = 0
    for shard in shard_paths(root):
        stats["shards"] += 1
        for sample in read_shard(shard):
            if limit is not None and done >= limit:
                return
            yield sample
            done += 1


def run(
    root: Path,
    out_root: Path,
    size: int = CROP_SIZE,
    limit: int | None = None,
    workers: int = 1,
    wide_size: int = WIDE_SIZE,
) -> dict:
    """Crop every annotated face into per-split shards under out_root.

    Decoding and re-encoding dominate, so they run across a pool while a single
    writer keeps records in parquet order: the shard index is a position, and a
    set of shards written out of order would index a different dataset.
    """
    stats = {"cropped": 0, "skipped": 0, "live": 0, "spoof": 0, "shards": 0}
    writers: dict[str, ShardWriter] = {}
    pool = Pool(workers) if workers > 1 else None
    try:
        for batch in batched(iter_samples(root, stats, limit), ENCODE_BATCH):
            payloads = [(sample, size, wide_size) for sample in batch]
            encoded = pool.map(_encode_task, payloads) if pool else map(_encode_task, payloads)
            for sample, members in zip(batch, encoded, strict=True):
                if members is None:
                    stats["skipped"] += 1
                    continue
                if sample.split not in writers:
                    writers[sample.split] = ShardWriter(out_root / sample.split)
                writers[sample.split].add(members)
                stats["cropped"] += 1
                stats["spoof" if sample.is_spoof else "live"] += 1
    finally:
        if pool is not None:
            pool.close()
            pool.join()
        for writer in writers.values():
            writer.close()
    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--size", type=int, default=CROP_SIZE)
    parser.add_argument("--wide-size", type=int, default=WIDE_SIZE)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--workers", type=int, default=os.cpu_count() or 1)
    args = parser.parse_args(argv)

    stats = run(args.root, args.out, args.size, args.limit, args.workers, args.wide_size)
    print(
        f"{args.out}: {stats['cropped']} face(s) from {stats['shards']} parquet shard(s) "
        f"({stats['live']} live, {stats['spoof']} spoof), {stats['skipped']} undecodable"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
