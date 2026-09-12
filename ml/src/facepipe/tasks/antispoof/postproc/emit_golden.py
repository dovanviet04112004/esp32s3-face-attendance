"""Golden cases for the anti-spoof face crop (KEHOACH 4.3).

Boxes are picked for the branches that decide the square: one that fits, one
wider than the frame so the cap bites, and two pressed against a corner so the
slide clamps. Frames are RGB565 because that is what drv_camera hands out.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from facepipe.export.emit_golden import write_case

from .preproc import FACE_SCALE, crop_face, fitted_square

# Detector-sized rather than HVGA: the square maths does not care, and a full
# frame would put 307 KB in every case file.
FRAME_HW = (120, 160)
CROP_SIZE = 81
# The deployed minifasnet_int8 input, and the mean and span preproc.cpp uses.
INPUT_SCALE = 0.003921569
INPUT_ZERO = -128
PIXEL_MEAN = 0.0
PIXEL_SPAN = 255.0


def boxes() -> list[np.ndarray]:
    return [
        np.array([60.0, 30.0, 100.0, 78.0], dtype=np.float32),
        np.array([5.0, 3.0, 45.0, 40.0], dtype=np.float32),
        np.array([-20.0, -15.0, 240.0, 180.0], dtype=np.float32),
        np.array([140.0, 85.0, 158.0, 116.0], dtype=np.float32),
        np.array([78.0, 58.0, 82.0, 62.0], dtype=np.float32),
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("contracts/golden/antispoof"))
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args(argv)

    rng = np.random.default_rng(args.seed)
    words = rng.integers(0, 1 << 16, FRAME_HW, dtype=np.uint16)
    for index, box in enumerate(boxes()):
        left, top, side = fitted_square(box, FACE_SCALE, FRAME_HW[1], FRAME_HW[0])
        write_case(
            args.out / "preproc" / f"case_{index:03d}.gold",
            {
                "frame": words,
                "frame_hw": np.array(FRAME_HW, dtype=np.int32),
                "box": box,
                "quant": np.array([INPUT_SCALE, float(INPUT_ZERO)], dtype=np.float32),
                "square": np.array([left, top, side], dtype=np.float32),
                "cropped": crop_face(words, box, CROP_SIZE, INPUT_SCALE, INPUT_ZERO,
                                     PIXEL_MEAN, PIXEL_SPAN),
            },
        )
    print(f"{args.out / 'preproc'}: {len(boxes())} case(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
