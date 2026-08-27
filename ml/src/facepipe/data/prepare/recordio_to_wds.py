"""MXNet RecordIO to webdataset tar shards.

MS1MV3 ships as a single .rec that only MXNet reads, and MXNet is unmaintained.
Rather than depend on it, this reads the RecordIO container directly: the format
is a magic word, a packed length, an IRHeader and the encoded image.

Glint360K needs none of this - its mirror is already sharded webdataset.

Usage:
    python -m facepipe.data.prepare.recordio_to_wds \\
        --rec data/raw/recognition/ms1mv3/train.rec \\
        --idx data/raw/recognition/ms1mv3/train.idx \\
        --out data/interim/recognition/ms1mv3_shards
"""

from __future__ import annotations

import argparse
import io
import struct
import tarfile
from collections.abc import Iterator
from dataclasses import dataclass
from itertools import batched, islice
from pathlib import Path

RECORD_MAGIC = 0xCED7230A
IR_HEADER = struct.Struct("IfQQ")
LENGTH_MASK = 0x1FFFFFFF
SHARD_SIZE = 10000


@dataclass
class Record:
    """One decoded RecordIO entry."""

    label: int
    image: bytes


def _padded(length: int) -> int:
    return (length + 3) // 4 * 4


def read_records(rec_path: Path) -> Iterator[Record]:
    """Walk a .rec sequentially, yielding label and encoded image bytes.

    A label stored as an array takes its first element: insightface writes
    [identity, ...] and only the identity matters here.
    """
    with rec_path.open("rb") as handle:
        while True:
            head = handle.read(8)
            if len(head) < 8:
                return
            magic, packed = struct.unpack("II", head)
            if magic != RECORD_MAGIC:
                raise ValueError(f"{rec_path}: bad magic {magic:#x} at {handle.tell() - 8}")
            length = packed & LENGTH_MASK
            payload = handle.read(_padded(length))[:length]
            if len(payload) < IR_HEADER.size:
                return
            flag, label, _id, _id2 = IR_HEADER.unpack_from(payload, 0)
            offset = IR_HEADER.size
            if flag > 0:
                labels = struct.unpack_from(f"{flag}f", payload, offset)
                label = labels[0]
                offset += 4 * flag
            yield Record(label=int(label), image=payload[offset:])


def count_index(idx_path: Path) -> int:
    """Number of records the .idx claims, used to report progress."""
    return sum(1 for line in idx_path.read_text(encoding="utf-8").splitlines() if line.strip())


def write_shards(
    records: Iterator[Record],
    out_dir: Path,
    shard_size: int = SHARD_SIZE,
    limit: int | None = None,
) -> dict:
    """Write records into numbered tar shards, one .jpg and one .cls per sample."""
    out_dir.mkdir(parents=True, exist_ok=True)
    stats = {"records": 0, "shards": 0, "identities": 0}
    identities: set[int] = set()

    stream = islice(records, limit) if limit is not None else records
    for shard_index, chunk in enumerate(batched(stream, shard_size)):
        with tarfile.open(out_dir / f"{shard_index:06d}.tar", "w") as shard:
            for offset, record in enumerate(chunk):
                key = f"{shard_index * shard_size + offset:09d}"
                _add(shard, f"{key}.jpg", record.image)
                _add(shard, f"{key}.cls", str(record.label).encode("ascii"))
                identities.add(record.label)
                stats["records"] += 1
        stats["shards"] += 1

    stats["identities"] = len(identities)
    return stats


def _add(shard: tarfile.TarFile, name: str, payload: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(payload)
    shard.addfile(info, io.BytesIO(payload))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rec", type=Path, required=True)
    parser.add_argument("--idx", type=Path, default=None)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--shard-size", type=int, default=SHARD_SIZE)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args(argv)

    if args.idx is not None and args.idx.is_file():
        print(f"{args.idx}: {count_index(args.idx)} record(s) indexed")

    stats = write_shards(read_records(args.rec), args.out, args.shard_size, args.limit)
    print(
        f"{args.out}: {stats['records']} record(s) in {stats['shards']} shard(s), "
        f"{stats['identities']} identities"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
