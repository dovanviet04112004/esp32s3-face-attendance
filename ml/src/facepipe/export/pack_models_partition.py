"""Join the deployed branch models into the image partition models_0 holds.

The 256 B header is the one KEHOACH 6.2.2 fixes and storage_format.h
declares field for field. A field written into the wrong slot does not show
up on the board as a wrong answer; it shows up as a partition failing its
own crc, so everything checkable is checked here instead.
"""

import argparse
import hashlib
import json
import struct
import time
import zlib
from dataclasses import dataclass
from pathlib import Path

# The name on flash is the entry name, not the branch directory, and this
# order is the order KEHOACH 6.2.2 lays the payloads out in.
BRANCH_ENTRY = {"detection": "detect", "antispoof": "spoof", "recognition": "recog"}

MAGIC = b"MDLS"
FORMAT_VER = 1
HEADER_BYTES = 256
ENTRY_BYTES = 64
ENTRY_SLOTS = 3
ENTRY_FORMAT = "<16sII32sHHI"
CRC_OFFSET = 252
PAYLOAD_ALIGN = 16                        # esp-nn reads weights aligned; ESP-DL copies otherwise
# Each runtime is told apart by its file's own magic, never by a header field (KEHOACH 6.2.2).
PAYLOAD_MAGIC = {"tflm": (4, b"TFL3"), "espdl": (0, b"EDL2")}


@dataclass(frozen=True)
class Model:
    """One branch as it will appear in the image."""

    branch: str
    entry_name: str
    path: Path
    sha256: str
    in_h: int
    in_w: int
    arena_hint: int


def payload_runtime(path: Path) -> str:
    """Which runtime a model file is for, from the magic the file itself carries."""
    head = path.read_bytes()[:8]
    for runtime, (offset, magic) in PAYLOAD_MAGIC.items():
        if head[offset:offset + len(magic)] == magic:
            return runtime
    raise SystemExit(f"{path.name}: neither a .tflite nor a plain .espdl")


def sha256_of(path: Path) -> str:
    """Hash a file the way both the lock file and the partition entry record it."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_size(cell: str) -> int:
    """One size cell of a partition table: hex, decimal, or a K/M suffix."""
    scale = {"K": 1024, "M": 1024 * 1024}.get(cell[-1:].upper(), 1)
    return int(cell[:-1] if scale > 1 else cell, 0) * scale


def partition_size(table: Path, name: str) -> int:
    """Read one partition's size from the table the firmware is built with."""
    for line in table.read_text(encoding="utf-8").splitlines():
        row = [cell.strip() for cell in line.split("#")[0].split(",")]
        if len(row) >= 5 and row[0] == name:
            return parse_size(row[4])
    raise SystemExit(f"no partition named {name} in {table}")


def deployed(lock_path: Path, models_dir: Path) -> list[Model]:
    """Collect the branches the lock deploys, refusing any that fails a check."""
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    unknown = sorted(set(lock) - set(BRANCH_ENTRY))
    if unknown:
        raise SystemExit(f"{lock_path}: no such branch {unknown}")

    models = []
    for branch, entry_name in BRANCH_ENTRY.items():
        record = lock.get(branch)
        if record is None:
            continue
        path = models_dir / branch / record["file"]
        if not path.is_file():
            raise SystemExit(f"{branch}: {path} is missing, run 50_pack_and_flash.sh first")
        digest = sha256_of(path)
        if digest != record["sha256"]:
            raise SystemExit(f"{branch}: {path.name} hashes {digest[:12]}, "
                             f"lock says {record['sha256'][:12]}")
        meta = json.loads((models_dir / branch / "meta.json").read_text(encoding="utf-8"))
        if meta["sha256"] != digest or meta["arena_hint"] != record["arena_bytes"]:
            raise SystemExit(f"{branch}: meta.json and the lock file disagree, rerun update_lock")
        models.append(Model(branch, entry_name, path, digest, meta["in_h"], meta["in_w"],
                            meta["arena_hint"]))
    if not models:
        raise SystemExit(f"{lock_path} deploys nothing")
    runtimes = {model.path.name: payload_runtime(model.path) for model in models}
    if len(set(runtimes.values())) != 1:
        raise SystemExit(f"{lock_path}: one image holds one runtime, got {runtimes}")
    return models


def build_image(models: list[Model], built_at: int) -> bytes:
    """Lay out the header and the payloads as KEHOACH 6.2.2 fixes them."""
    payload = bytearray()
    entries = b""
    for model in models:
        blob = model.path.read_bytes()
        entries += struct.pack(ENTRY_FORMAT, model.entry_name.encode(), HEADER_BYTES + len(payload),
                               len(blob), bytes.fromhex(model.sha256), model.in_h, model.in_w,
                               model.arena_hint)
        payload += blob
        payload += bytes(-len(payload) % PAYLOAD_ALIGN)

    header = struct.pack("<4sIII", MAGIC, FORMAT_VER, len(models), built_at)
    header += entries + bytes(ENTRY_BYTES * (ENTRY_SLOTS - len(models)))
    header += bytes(CRC_OFFSET - len(header))
    # esp_rom_crc32_le(0, ...) is zlib's crc32: same table, same inversions.
    header += struct.pack("<I", zlib.crc32(header))
    return bytes(header) + bytes(payload)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, default=Path("contracts/models.lock.json"))
    parser.add_argument("--models-dir", type=Path, default=Path("firmware/models"))
    parser.add_argument("--partitions", type=Path, default=Path("firmware/partitions.dev.csv"))
    parser.add_argument("--partition", default="models_0", help="which slot the image is for")
    parser.add_argument("--out", type=Path, required=True, help="where models.bin goes")
    args = parser.parse_args(argv)

    models = deployed(args.lock, args.models_dir)
    image = build_image(models, int(time.time()))
    capacity = partition_size(args.partitions, args.partition)
    if len(image) > capacity:
        raise SystemExit(f"image is {len(image)} B, {args.partition} holds {capacity} B")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(image)
    for model in models:
        print(f"{model.entry_name:8s} {model.path.name:28s} {model.in_h}x{model.in_w}  "
              f"{model.path.stat().st_size / 1024.0:8.1f} KB  arena {model.arena_hint}")
    print(f"{args.out}  {len(image) / 1024.0:.1f} KB of {capacity / 1024.0:.0f} KB "
          f"{args.partition}, {len(models)} of {ENTRY_SLOTS} branches, "
          f"runtime {payload_runtime(models[0].path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
