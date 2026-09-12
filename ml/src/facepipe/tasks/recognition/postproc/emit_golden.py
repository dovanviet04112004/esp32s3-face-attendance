"""Golden cases for align, l2norm and cosine (KEHOACH 4.3).

Cases are built from a fixed seed rather than from a dataset: the board checks
arithmetic, and a face crop would only make the file large. Profile-like and
degenerate landmark sets are in on purpose, since those are the ones where the
reflection guard and the zero-norm branch decide the answer.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from facepipe.export.emit_golden import write_case
from facepipe.tasks.antispoof.postproc.preproc import unpack_rgb565

from .align import ALIGNED_SIZE, align, reference_landmarks, similarity_transform
from .cosine import cosine_int8, quantize
from .l2norm import l2_normalize

FRAME_HW = (120, 160)
EMBEDDING = 512
# The deployed mobilefacenet_int8 input, so the case carries the real operating point.
INPUT_SCALE = 0.007843138
INPUT_ZERO = -1
PIXEL_MEAN = 127.5
PIXEL_SPAN = 127.5
# The deployed embedding output, which is what normalized_int8 reads.
EMBED_SCALE = 0.038641058
EMBED_ZERO = 8


def quantized_pixels(image: np.ndarray) -> np.ndarray:
    """The int8 block align_face writes, by the formula in pixels.cpp Quantizer."""
    scaled = (image.astype(np.float32) - PIXEL_MEAN) / PIXEL_SPAN / np.float32(INPUT_SCALE)
    return np.clip(np.rint(scaled) + INPUT_ZERO, -128, 127).astype(np.int8)


def landmark_cases() -> list[np.ndarray]:
    """Centred, rotated, near-profile and tiny: each case carries a 96 KB frame.

    Near-profile is the one that decides the reflection guard, tiny is the one
    that pushes the warp to upsample past every source pixel.
    """
    base = reference_landmarks(ALIGNED_SIZE) * 0.6 + np.array([40.0, 28.0])
    return [
        base.astype(np.float32),
        (base @ np.array([[0.94, -0.34], [0.34, 0.94]]).T).astype(np.float32),
        (base * np.array([0.35, 1.0]) + np.array([70.0, 10.0])).astype(np.float32),
        (base * 0.25 + np.array([12.0, 8.0])).astype(np.float32),
    ]


def emit_align(root: Path, rng: np.random.Generator) -> int:
    # drv_camera hands out RGB565, so the reference warps the unpacked words
    # rather than an rgb888 frame the board never sees.
    words = rng.integers(0, 1 << 16, FRAME_HW, dtype=np.uint16)
    frame = unpack_rgb565(words).astype(np.uint8)
    cases = landmark_cases()
    for index, landmarks in enumerate(cases):
        matrix = similarity_transform(landmarks, reference_landmarks(ALIGNED_SIZE))
        write_case(
            root / "align" / f"case_{index:03d}.gold",
            {
                "frame": words,
                "frame_hw": np.array(FRAME_HW, dtype=np.int32),
                "landmarks": landmarks.reshape(-1).astype(np.float32),
                "quant": np.array([INPUT_SCALE, float(INPUT_ZERO)], dtype=np.float32),
                "matrix": matrix.reshape(-1).astype(np.float32),
                "aligned": quantized_pixels(align(frame, landmarks, ALIGNED_SIZE)),
            },
        )
    return len(cases)


def emit_l2norm(root: Path, rng: np.random.Generator) -> int:
    """Raw int8 embeddings in, the unit int8 vector and its scale out."""
    raws = [
        rng.integers(-128, 128, EMBEDDING).astype(np.int8),
        np.full(EMBEDDING, EMBED_ZERO, dtype=np.int8),
        np.full(EMBEDDING, 127, dtype=np.int8),
        (rng.integers(-4, 5, EMBEDDING) + EMBED_ZERO).astype(np.int8),
    ]
    for index, raw in enumerate(raws):
        dequantized = (raw.astype(np.float32) - EMBED_ZERO) * np.float32(EMBED_SCALE)
        unit, scale = quantize(l2_normalize(dequantized).astype(np.float32))
        write_case(
            root / "l2norm" / f"case_{index:03d}.gold",
            {
                "raw": raw,
                "quant": np.array([EMBED_SCALE, float(EMBED_ZERO)], dtype=np.float32),
                "unit": unit,
                "scale": np.array([scale], dtype=np.float32),
            },
        )
    return len(raws)


def emit_cosine(root: Path, rng: np.random.Generator) -> int:
    pairs = []
    unit = l2_normalize(rng.normal(0, 1, EMBEDDING).astype(np.float32))
    pairs.append((unit, unit))
    pairs.append((unit, l2_normalize(rng.normal(0, 1, EMBEDDING).astype(np.float32))))
    drifted = l2_normalize((unit + rng.normal(0, 0.15, EMBEDDING)).astype(np.float32))
    pairs.append((unit, drifted))
    pairs.append((unit, l2_normalize((-unit).astype(np.float32))))
    for index, (left, right) in enumerate(pairs):
        query, query_scale = quantize(left)
        template, template_scale = quantize(right)
        write_case(
            root / "cosine" / f"case_{index:03d}.gold",
            {
                "query": query,
                "template": template,
                "scales": np.array([query_scale, template_scale], dtype=np.float32),
                "similarity": np.array([cosine_int8(query, template)], dtype=np.float32),
            },
        )
    return len(pairs)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("contracts/golden/recognition"))
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args(argv)

    rng = np.random.default_rng(args.seed)
    written = {
        "align": emit_align(args.out, rng),
        "l2norm": emit_l2norm(args.out, rng),
        "cosine": emit_cosine(args.out, rng),
    }
    for name, count in written.items():
        print(f"{args.out / name}: {count} case(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
