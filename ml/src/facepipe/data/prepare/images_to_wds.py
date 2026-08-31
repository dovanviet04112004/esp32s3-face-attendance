"""Sequential tar shards, and the one place the record layout is defined.

A record is every tar member sharing the text before the first dot, which is the
WebDataset convention the MS1MV3 shards already follow. Grouping that way lets a
record carry more than one payload: the anti-spoof branch stores both crop scales
of one face together, so an epoch pays one read where two files cost two.

Sharding is what makes an epoch affordable for the branches with hundreds of
thousands of samples; see KEHOACH section 4.4.1 for which branch needs which.

Usage:
    python -m facepipe.data.prepare.images_to_wds \\
        --images data/interim/detection/widerface_yolo/images/train \\
        --out data/interim/detection/widerface_shards/train
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
KEY_FIELD = "__key__"


@dataclass
class ShardStats:
    records: int = 0
    shards: int = 0
    bytes_written: int = 0
    seconds: float = 0.0

    def as_dict(self) -> dict[str, float]:
        return {
            "records": self.records,
            "shards": self.shards,
            "megabytes": round(self.bytes_written / 2**20, 1),
            "records_per_second": round(self.records / self.seconds, 1) if self.seconds else 0.0,
        }


def shard_path(out_dir: Path, index: int) -> Path:
    return out_dir / f"{SHARD_STEM}_{index:05d}.tar"


class ShardWriter:
    """Append records to a directory of fixed-size tar shards.

    Every member of one record is written back to back, so a reader that streams
    the shard front to back never has to seek to assemble one.
    """

    def __init__(self, out_dir: Path, shard_size: int = SHARD_SIZE) -> None:
        self.out_dir = Path(out_dir)
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.shard_size = shard_size
        self.stats = ShardStats()
        self._archive: tarfile.TarFile | None = None
        self._started = time.perf_counter()

    def add(self, members: dict[str, bytes]) -> None:
        """Write one record, keyed by its position, with the given extensions."""
        if self.stats.records % self.shard_size == 0:
            self._roll()
        key = f"{self.stats.records:09d}"
        for suffix, payload in members.items():
            info = tarfile.TarInfo(f"{key}.{suffix}")
            info.size = len(payload)
            info.mtime = 0
            self._archive.addfile(info, io.BytesIO(payload))
            self.stats.bytes_written += info.size
        self.stats.records += 1

    def _roll(self) -> None:
        if self._archive is not None:
            self._archive.close()
        self._archive = tarfile.open(  # noqa: SIM115 - closed by close() or __exit__
            shard_path(self.out_dir, self.stats.shards), "w"
        )
        self.stats.shards += 1

    def close(self) -> ShardStats:
        if self._archive is not None:
            self._archive.close()
            self._archive = None
        self.stats.seconds = time.perf_counter() - self._started
        return self.stats

    def __enter__(self) -> ShardWriter:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def read_shard(path: Path) -> Iterator[dict[str, bytes]]:
    """Stream one shard back as records mapping extension to payload.

    Opened in stream mode: a shard is read front to back, never seeked, which is
    the access pattern the whole layout exists to produce.

    The grouping text is returned under KEY_FIELD as well, following WebDataset.
    A branch that caches per-record data outside the shard needs it to line the
    two up; the extension keys stay exactly what the writer was given.
    """
    current_key: str | None = None
    record: dict[str, bytes] = {}
    with tarfile.open(path, "r|") as archive:
        for member in archive:
            key, _, suffix = member.name.partition(".")
            if key != current_key:
                if record:
                    yield record
                current_key, record = key, {KEY_FIELD: key.encode("ascii")}
            handle = archive.extractfile(member)
            record[suffix] = handle.read() if handle else b""
    if record:
        yield record


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


def write_shards(
    paths: Sequence[Path],
    out_dir: Path,
    max_side: int | None = None,
    shard_size: int = SHARD_SIZE,
    sidecar: dict[str, dict] | None = None,
) -> ShardStats:
    """Pack every image into shards of shard_size, in the order given."""
    with ShardWriter(out_dir, shard_size) as writer:
        for path in paths:
            payload, meta = encode(path, max_side)
            if sidecar and path.name in sidecar:
                meta.update(sidecar[path.name])
            writer.add({"jpg": payload, "json": json.dumps(meta).encode()})
    return writer.stats


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
