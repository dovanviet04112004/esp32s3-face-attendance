"""Synthesise the beep the kiosk plays when it opens the door (KEHOACH 6.2.8)."""

from __future__ import annotations

import argparse
import math
import re
import struct
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
DRV_AUDIO = HERE.parent.parent / "components" / "drv_audio" / "include" / "drv_audio.h"
TONE_HZ = 2000
LENGTH_MS = 150
EDGE_MS = 5
# Half scale, not full (KEHOACH 6.2.8).
PEAK_SCALE = 0.5
FULL_SCALE = 32767


def sample_hz() -> int:
    """The rate drv_audio plays at, read from the header it compiles against."""
    m = re.search(r"#define DRV_AUDIO_SAMPLE_HZ\s+(\d+)", DRV_AUDIO.read_text(encoding="utf-8"))
    if m is None:
        raise SystemExit(f"{DRV_AUDIO}: no DRV_AUDIO_SAMPLE_HZ")
    return int(m.group(1))


def beep(rate_hz: int) -> list[int]:
    """One sine tone whose cosine edges keep the speaker from clicking at either end."""
    count = rate_hz * LENGTH_MS // 1000
    edge = rate_hz * EDGE_MS // 1000
    pcm = []
    for i in range(count):
        near = min(i, count - 1 - i)
        gain = 0.5 - 0.5 * math.cos(math.pi * near / edge) if near < edge else 1.0
        phase = 2.0 * math.pi * TONE_HZ * i / rate_hz
        pcm.append(round(FULL_SCALE * PEAK_SCALE * gain * math.sin(phase)))
    return pcm


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=HERE / "beep.wav")
    args = parser.parse_args(argv)

    rate_hz = sample_hz()
    pcm = beep(rate_hz)
    with wave.open(str(args.out), "wb") as clip:
        clip.setnchannels(1)
        clip.setsampwidth(2)
        clip.setframerate(rate_hz)
        clip.writeframes(struct.pack(f"<{len(pcm)}h", *pcm))
    print(f"{args.out}  {TONE_HZ} Hz for {LENGTH_MS} ms at {PEAK_SCALE:g} of full scale")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
