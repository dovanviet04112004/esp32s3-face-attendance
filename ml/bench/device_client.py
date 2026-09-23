"""Read what the board kept, over the console it already speaks on.

Two dumps, both from drv_camera/test_apps/sensor: `shots` hands back the JPEGs
the button kept on flash, `raw` streams fresh RGB565 frames. The board arms its
keeping case unless a host answers inside a six second window, so every mode
starts by typing through that window to claim the unity menu.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import re
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import serial
from PIL import Image

COLD_DRIVE = Path("/mnt/e/face-attendance-data/raw/device/ov5640")
SHOT_CASE = '"hand back the frames the button kept"'
RAW_CASE = '"metered frames reach the host as raw rgb565"'
MENU_PROMPT = b"Enter test for running"
CLAIM_TIMEOUT_S = 20
QUIET_TIMEOUT_S = 8
# Unity prints one of these when a case ends, including when it kept nothing.
CASE_OVER = (b"--SHOTS DONE", b":IGNORE", b":FAIL", b"Tests 0 Failures")
# The task watchdog logs into the stream while the main task is busy writing.
LOG_LINE = re.compile(rb"[EWIDV] \(\d+\) [^\r\n]*")
SHOT_HEAD = re.compile(rb"--SHOT ([\w.\-]+) (\d+)--")
RAW_HEAD = re.compile(rb"--RAW (\d+)x(\d+) level (-?\d+) exposure (\d+) gain16 (\d+)--")
SHOT_METER = re.compile(r"_L(\d+)_E(\d+)_G(\d+)\.jpg$")


def opened(port: str) -> serial.Serial:
    """The port with the board reset, which is how a case is reached at all."""
    # Without a write timeout a blocked usb buffer stops the host for good.
    handle = serial.Serial(port, 115200, timeout=0.2, write_timeout=1)
    handle.dtr = False
    handle.rts = True
    time.sleep(0.1)
    handle.rts = False
    return handle


def claim(handle: serial.Serial, case: str) -> bool:
    """Type through the arming window, then ask the menu for one case."""
    buf, started = b"", time.time()
    while time.time() - started < CLAIM_TIMEOUT_S:
        buf += handle.read(65536)
        if MENU_PROMPT in buf:
            handle.write(case.encode() + b"\n")
            return True
        with contextlib.suppress(serial.SerialTimeoutException):
            handle.write(b"\n")
    return False


def payload_of(segment: bytes, expected: int | None = None) -> bytes | None:
    """Hex between the markers, with any log line the board interleaved removed."""
    cleaned = LOG_LINE.sub(b"", segment).replace(b"\r", b"").replace(b"\n", b"")
    try:
        raw = bytes.fromhex(cleaned.decode())
    except ValueError as err:
        print(f"  dropped: {err}")
        return None
    if expected is not None and len(raw) != expected:
        print(f"  dropped: {len(raw)} of {expected} bytes")
        return None
    return raw


def frames(handle: serial.Serial, head: re.Pattern, on_frame) -> int:
    """Feed every marked block to on_frame until the board goes quiet."""
    buf, seen, last = b"", 0, time.time()
    while time.time() - last < QUIET_TIMEOUT_S:
        chunk = handle.read(65536)
        if chunk:
            buf += chunk
            last = time.time()
        while (found := head.search(buf)) is not None:
            end = buf.find(b"--END--", found.end())
            if end < 0:
                break
            block = buf[found.end() : end]
            buf = buf[end + 7 :]
            seen += on_frame(found, block)
        if any(mark in buf for mark in CASE_OVER):
            break
    return seen


def described(stem: str, suffix: str, session: str, seq: int, labels: dict) -> dict:
    """The manifest columns a row needs, with what only the operator knows filled in."""
    return {
        "file": f"images/{stem}{suffix}",
        "session": session,
        "seq": seq,
        "capture_date": datetime.now().isoformat(timespec="seconds"),
        **labels,
    }


def written(meta_dir: Path, stem: str, payload: dict) -> None:
    meta_dir.mkdir(parents=True, exist_ok=True)
    (meta_dir / f"{stem}.json").write_text(json.dumps(payload, indent=1), encoding="utf-8")


def pull_shots(handle: serial.Serial, session: str, labels: dict) -> int:
    """Save the button's JPEGs under the repo naming, meter state moved into the json."""
    images, meta = COLD_DRIVE / "images", COLD_DRIVE / "meta"
    images.mkdir(parents=True, exist_ok=True)
    index = 0

    def keep(found: re.Match, block: bytes) -> int:
        nonlocal index
        name, length = found.group(1).decode(), int(found.group(2))
        raw = payload_of(block, length)
        if raw is None:
            return 0
        stem = f"{session}_{index:03d}"
        (images / f"{stem}.jpg").write_bytes(raw)
        metered = SHOT_METER.search(name)
        level, exposure, gain16 = (int(v) for v in metered.groups()) if metered else (-1, 0, 0)
        written(
            meta,
            stem,
            described(stem, ".jpg", session, index, labels)
            | {
                "board_file": name,
                "meter_level_green6": level,
                "exposure_lines": exposure,
                "gain16": gain16,
            },
        )
        print(f"  {stem}.jpg  {length} B  level {level} exposure {exposure} gain16 {gain16}")
        index += 1
        return 1

    return frames(handle, SHOT_HEAD, keep)


def pull_raw(handle: serial.Serial, session: str, labels: dict) -> int:
    """Save fresh frames as lossless png, one meta file each."""
    images, meta = COLD_DRIVE / "images", COLD_DRIVE / "meta"
    images.mkdir(parents=True, exist_ok=True)
    index = 0

    def keep(found: re.Match, block: bytes) -> int:
        nonlocal index
        width, height, level, exposure, gain16 = (int(v) for v in found.groups())
        raw = payload_of(block, width * height * 2)
        if raw is None:
            return 0
        words = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 2)
        # The dvp lands the high byte first.
        packed = (words[..., 0].astype(np.uint16) << 8) | words[..., 1].astype(np.uint16)
        red, green, blue = (packed >> 11) & 0x1F, (packed >> 5) & 0x3F, packed & 0x1F
        rgb = np.stack(
            [
                (red << 3) | (red >> 2),
                (green << 2) | (green >> 4),
                (blue << 3) | (blue >> 2),
            ],
            axis=-1,
        ).astype(np.uint8)
        stem = f"{session}_{index:03d}"
        Image.fromarray(rgb).save(images / f"{stem}.png")
        written(
            meta,
            stem,
            described(stem, ".png", session, index, labels)
            | {
                "width": width,
                "height": height,
                "pixel_format": "rgb565_be",
                "meter_level_green6": level,
                "exposure_lines": exposure,
                "gain16": gain16,
            },
        )
        print(f"  {stem}  level {level} exposure {exposure} gain16 {gain16}")
        index += 1
        return 1

    return frames(handle, RAW_HEAD, keep)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("shots", "raw"))
    parser.add_argument("session", help="prefix the saved files carry")
    parser.add_argument("--port", default="/dev/ttyACM0")
    parser.add_argument("--person", default="", help="identity, without which no split is disjoint")
    parser.add_argument("--lighting", default="", help="scene, e.g. office, backlit, outdoor-sun")
    parser.add_argument("--distance-cm", default="")
    parser.add_argument("--spoof", default="", help="attack kind, empty for a live capture")
    args = parser.parse_args(argv)

    labels = {
        "person_id": args.person,
        "lighting": args.lighting,
        "distance_cm": args.distance_cm,
        "is_spoof": 1 if args.spoof else 0,
        "spoof_type": args.spoof,
    }
    handle = opened(args.port)
    try:
        case = SHOT_CASE if args.mode == "shots" else RAW_CASE
        print(f"claiming the menu on {args.port}, the board runs its suite first")
        if not claim(handle, case):
            print("the board never offered its menu")
            return 1
        saved = (
            pull_shots(handle, args.session, labels)
            if args.mode == "shots"
            else pull_raw(handle, args.session, labels)
        )
    finally:
        handle.close()
    print(f"saved {saved} file(s) under {COLD_DRIVE}")
    return 0 if saved else 1


if __name__ == "__main__":
    raise SystemExit(main())
