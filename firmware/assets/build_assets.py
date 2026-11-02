"""Build the SPIFFS image the `assets` partition carries (KEHOACH 6.2.8).

The device paths are fixed so firmware never names a source file: swapping the
sound means editing STAGE here, not a line of C.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
# device path <- source file, relative to this directory
STAGE = {"snd/ok.wav": "sounds/xincamon-1_1.wav"}
STORAGE_FORMAT = HERE.parent / "components" / "sys_storage" / "include" / "storage_format.h"
WAVE_FORMAT_PCM = 1
WANT_RATE_HZ = 16000
WANT_CHANNELS = 1
WANT_WIDTH_BITS = 16


def sound_cap_bytes() -> int:
    """The largest clip file audio_task buffers, read from the header it compiles against."""
    text = STORAGE_FORMAT.read_text(encoding="utf-8")
    m = re.search(r"#define STORAGE_SOUND_CAP_BYTES\s+\(?\s*(\d+)(?:\s*\*\s*(\d+))?\s*\)?", text)
    if m is None:
        raise SystemExit(f"{STORAGE_FORMAT}: no STORAGE_SOUND_CAP_BYTES")
    return int(m.group(1)) * int(m.group(2) or 1)


def format_code(path: Path) -> int:
    """The fmt chunk's format code: wave also opens WAVE_FORMAT_EXTENSIBLE, the device does not."""
    data = path.read_bytes()
    at = 12
    while at + 8 <= len(data):
        size = int.from_bytes(data[at + 4 : at + 8], "little")
        if data[at : at + 4] == b"fmt ":
            return int.from_bytes(data[at + 8 : at + 10], "little")
        at += 8 + size + (size & 1)
    raise SystemExit(f"{path.name}: no fmt chunk")


def checked(path: Path) -> None:
    """Refuse a clip audio_task would not play, where the message still names it."""
    cap = sound_cap_bytes()
    size = path.stat().st_size
    if size > cap:
        raise SystemExit(f"{path.name}: {size} bytes, audio_task buffers at most {cap}")
    code = format_code(path)
    if code != WAVE_FORMAT_PCM:
        raise SystemExit(f"{path.name}: format 0x{code:04x}, want plain PCM (1)")
    with wave.open(str(path)) as clip:
        rate, channels, width = clip.getframerate(), clip.getnchannels(), clip.getsampwidth() * 8
        seconds = clip.getnframes() / float(rate)
    if (rate, channels, width) != (WANT_RATE_HZ, WANT_CHANNELS, WANT_WIDTH_BITS):
        raise SystemExit(
            f"{path.name}: {rate} Hz {channels}ch {width}-bit, "
            f"want {WANT_RATE_HZ} Hz {WANT_CHANNELS}ch {WANT_WIDTH_BITS}-bit"
        )
    print(f"  snd  {path.name}  {seconds:.2f} s")


def staged(root: Path) -> None:
    for device_path, source in STAGE.items():
        src = HERE / source
        if not src.is_file():
            raise SystemExit(f"missing source {src}")
        if src.suffix.lower() == ".wav":
            checked(src)
        out = root / device_path
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, out)


def partition_size(table: Path, name: str) -> int:
    for line in table.read_text(encoding="utf-8").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 5 and parts[0] == name:
            return int(parts[4], 0)
    raise SystemExit(f"{table}: no partition named {name}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=HERE.parent / "build" / "assets.bin")
    parser.add_argument("--partitions", type=Path, default=HERE.parent / "partitions.dev.csv")
    parser.add_argument("--partition", default="assets")
    args = parser.parse_args(argv)

    idf = os.environ.get("IDF_PATH")
    if not idf:
        raise SystemExit("IDF_PATH is unset; run . $IDF_PATH/export.sh first")
    generator = Path(idf) / "components" / "spiffs" / "spiffsgen.py"
    if not generator.is_file():
        raise SystemExit(f"missing {generator}")

    size = partition_size(args.partitions, args.partition)
    root = args.out.parent / "assets_root"
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True, exist_ok=True)
    staged(root)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [sys.executable, str(generator), str(size), str(root), str(args.out)], check=True
    )
    print(
        f"{args.out}  {args.out.stat().st_size / 1024.0:.1f} KB of {size / 1024.0:.0f} KB "
        f"{args.partition}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
