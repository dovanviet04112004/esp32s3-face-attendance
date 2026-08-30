"""Loose image files to sequential shards, resized to what training reads.

Measured on drvfs: 1668 images a second out of a tar against 66 from loose files.
The mount does 150 MB/s sequentially and spends 15 ms per open, so an epoch pays
for opens, not bytes.

Both halves are needed. Sharding moves the cost off drvfs, which does not scale
with workers; resizing moves what is left onto JPEG decode, which does.

Usage:
    python -m facepipe.data.prepare.images_to_wds \\
        --images data/interim/detection/widerface_yolo/images/train \\
        --out data/interim/detection/widerface_shards/train --max-side 640
"""

from __future__ import annotations

import argparse
import io
import json
import tarfile
import time
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

SHARD_SIZE = 2000
SHARD_STEM = "shard"
JPEG_QUALITY = 90
IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png")


@dataclass
class ShardStats:
    images: int = 0
    shards: int = 0
    bytes_written: int = 0
    seconds: float = 0.0

    def as_dict(self) -> dict[str, float]:
        return {
            "images": self.images,
            "shards": self.shards,
            "megabytes": round(self.bytes_written / 2**20, 1),
            "images_per_second": round(self.images / self.seconds, 1) if self.seconds else 0.0,
        }


def encode(path: Path, max_side: int | None, quality: int = JPEG_QUALITY) -> tuple[bytes, dict]:
    """Read one image, optionally shrink its long side, and re-encode as JPEG.

    The original size travels with the record. Boxes and landmarks are stored in
    the source's own pixel frame, so a reader that does not know the scale would
    place every annotation wrong while producing a perfectly valid image.
    """
    with Image.open(path) as handle:
        image = handle.convert("RGB")
        width, height = image.size
        if max_side and max(width, height) > max_side:
            scale = max_side / max(width, height)
            image = image.resize((round(width * scale), round(height * scale)), Image.BILINEAR)

    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality)
    return buffer.getvalue(), {
        "name": path.name,
        "width": width,
        "height": height,
        "stored_width": image.size[0],
        "stored_height": image.size[1],
    }


def shard_path(out_dir: Path, index: int) -> Path:
    return out_dir / f"{SHARD_STEM}_{index:05d}.tar"


def add_record(archive: tarfile.TarFile, key: str, payload: bytes, meta: dict) -> int:
    """Write the image and its metadata under one key.

    The label rides in a json member rather than its own tiny file per record:
    tar rounds every member up to 512 bytes, so a member holding one number still
    costs a kilobyte with its header.
    """
    written = 0
    for suffix, blob in ((".jpg", payload), (".json", json.dumps(meta).encode())):
        info = tarfile.TarInfo(f"{key}{suffix}")
        info.size = len(blob)
        info.mtime = 0
        archive.addfile(info, io.BytesIO(blob))
        written += info.size
    return written


def write_shards(
    paths: Sequence[Path],
    out_dir: Path,
    max_side: int | None = None,
    shard_size: int = SHARD_SIZE,
    sidecar: dict[str, dict] | None = None,
) -> ShardStats:
    """Pack every image into shards of shard_size, in the order given."""
    out_dir.mkdir(parents=True, exist_ok=True)
    stats = ShardStats()
    started = time.perf_counter()

    archive: tarfile.TarFile | None = None
    for index, path in enumerate(paths):
        if index % shard_size == 0:
            if archive is not None:
                archive.close()
            archive = tarfile.open(shard_path(out_dir, stats.shards), "w")
            stats.shards += 1

        payload, meta = encode(path, max_side)
        if sidecar and path.name in sidecar:
            meta.update(sidecar[path.name])
        stats.bytes_written += add_record(archive, f"{index:09d}", payload, meta)
        stats.images += 1

    if archive is not None:
        archive.close()
    stats.seconds = time.perf_counter() - started
    return stats


def read_shard(path: Path) -> Iterator[tuple[bytes, dict]]:
    """Stream one shard back, pairing each image with its metadata.

    Opened in stream mode: a shard is read front to back, never seeked, which is
    the access pattern the whole layout exists to produce.
    """
    pending: dict[str, dict] = {}
    with tarfile.open(path, "r|") as archive:
        for member in archive:
            key, _, suffix = member.name.rpartition(".")
            blob = archive.extractfile(member).read()
            if suffix == "json":
                meta = json.loads(blob)
                if key in pending:
                    yield pending.pop(key)["image"], meta
                else:
                    pending[key] = {"meta": meta}
            else:
                if key in pending and "meta" in pending[key]:
                    yield blob, pending.pop(key)["meta"]
                else:
                    pending[key] = {"image": blob}


def list_images(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*") if p.suffix.lower() in IMAGE_SUFFIXES)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--max-side", type=int)
    parser.add_argument("--shard-size", type=int, default=SHARD_SIZE)
    args = parser.parse_args(argv)

    paths = list_images(args.images)
    if not paths:
        print(f"{args.images}: no images")
        return 1
    stats = write_shards(paths, args.out, args.max_side, args.shard_size)
    print(f"{args.out}: {stats.as_dict()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
