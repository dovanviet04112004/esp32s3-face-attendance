"""Depth labels for the anti-spoof branch, one npz beside every shard (KEHOACH 3).

The estimator reads the wide view and the map is cut back to face_in_wide: a
crop the face fills leaves it no scene to anchor on, and it answers with a
tilted plane. Attacks are a plane by definition and carry zeros without being
looked at.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

from facepipe.data.prepare.images_to_wds import read_shard

# Three times the 21x21 the head reads: crop and roll resample the map, and a
# 0.7 bite off a 21 grid comes back at 0.735 correlation (measurements 42).
GRID = 63
# The estimator's own normalisation, shipped with it.
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
# A multiple of 14, the patch size the graph floors its input to. The knee sits
# here: 126 halves label agreement and 350 buys nothing back (measurements 42).
ESTIMATOR_SIDE = 224
# Below the tenth percentile of agreement at this side, so it drops the tail the
# estimator reads wrong rather than a tenth of the pool (measurements 42).
TRUST_FLOOR = 0.30
LIVE = 0


def normalised(patch: np.ndarray) -> np.ndarray:
    """Zero mean and unit spread, so absolute range never reaches the loss."""
    return (patch - patch.mean()) / max(float(patch.std()), 1e-6)


def face_map(session: ort.InferenceSession, wide: np.ndarray, box) -> np.ndarray | None:
    """The estimator's depth over the wide view, cut to the face and squared off."""
    name = session.get_inputs()[0].name
    scaled = np.asarray(
        Image.fromarray(wide).resize((ESTIMATOR_SIDE, ESTIMATOR_SIDE), Image.BILINEAR),
        dtype=np.float32,
    ) / 255.0
    planes = ((scaled - IMAGENET_MEAN) / IMAGENET_STD).transpose(2, 0, 1)[None]
    depth = session.run(None, {name: planes})[0][0]
    height, width = depth.shape
    x0, y0, x1, y1 = box
    top, bottom = int(max(0.0, y0) * height), int(min(1.0, y1) * height)
    left, right = int(max(0.0, x0) * width), int(min(1.0, x1) * width)
    cut = depth[top : max(bottom, top + 1), left : max(right, left + 1)]
    if cut.size < 4:
        return None
    return normalised(np.asarray(Image.fromarray(cut).resize((GRID, GRID), Image.BILINEAR)))


def agreement(patch: np.ndarray, shape: np.ndarray) -> float:
    """Correlation with the mean live shape, which is this label's own trust."""
    a, b = patch.ravel() - patch.mean(), shape.ravel() - shape.mean()
    return float(np.dot(a, b) / max(float(np.linalg.norm(a) * np.linalg.norm(b)), 1e-9))


def mean_shape(session: ort.InferenceSession, shards: list[Path], wanted: int) -> np.ndarray:
    """The average live face, fitted before any label is judged against it."""
    seen: list[np.ndarray] = []
    for shard in shards:
        for record in read_shard(shard):
            meta = json.loads(record["json"])
            if int(meta["label"]) != LIVE:
                continue
            patch = face_map(session, decoded(record["wide.jpg"]), face_box(meta))
            if patch is not None:
                seen.append(patch)
            if len(seen) >= wanted:
                return np.mean(seen, axis=0)
    if not seen:
        raise RuntimeError("no live records found to fit the mean shape")
    return np.mean(seen, axis=0)


def decoded(payload: bytes) -> np.ndarray:
    import io

    with Image.open(io.BytesIO(payload)) as handle:
        return np.asarray(handle.convert("RGB"), dtype=np.uint8)


def named(root: Path, spec: str) -> list[Path]:
    """Shards of "folder" or "folder:start:end", the slicing the splits already use."""
    parts = str(spec).split(":")
    shards = sorted((root / parts[0]).glob("shard_*.tar"))
    if len(parts) == 1:
        return shards
    if len(parts) != 3:
        raise ValueError(f"{spec!r}: expected 'folder' or 'folder:start:end'")
    return shards[int(parts[1] or 0) : int(parts[2]) if parts[2] else len(shards)]


def face_box(meta: dict) -> tuple[float, float, float, float]:
    box = meta.get("face_in_wide")
    return tuple(box) if box else (0.0, 0.0, 1.0, 1.0)


def write_shard(session, shard: Path, shape: np.ndarray, out: Path) -> tuple[int, int]:
    """One npz per shard, rows in record order, so the loader keys by position."""
    maps, trust = [], []
    for record in read_shard(shard):
        meta = json.loads(record["json"])
        if int(meta["label"]) != LIVE:
            maps.append(np.zeros((GRID, GRID), dtype=np.float16))
            trust.append(np.float16(1.0))
            continue
        patch = face_map(session, decoded(record["wide.jpg"]), face_box(meta))
        if patch is None:
            maps.append(np.zeros((GRID, GRID), dtype=np.float16))
            trust.append(np.float16(0.0))
            continue
        maps.append(patch.astype(np.float16))
        trust.append(np.float16(agreement(patch, shape)))
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, depth=np.stack(maps), trust=np.asarray(trust, dtype=np.float16))
    kept = int(sum(1 for t in trust if float(t) >= TRUST_FLOOR))
    return len(maps), kept


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shards", type=Path, required=True, help="the crop shard root")
    parser.add_argument("--model", type=Path, required=True, help="the estimator, onnx")
    parser.add_argument("--out", type=Path, required=True, help="where the npz files go")
    parser.add_argument("--folders", nargs="+", required=True, help="shard folders to cover")
    parser.add_argument("--shape-samples", type=int, default=200)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args(argv)

    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    session = ort.InferenceSession(
        str(args.model), options, providers=["CPUExecutionProvider"]
    )

    every = [s for spec in args.folders for s in named(args.shards, spec)]
    if not every:
        raise SystemExit(f"{args.shards}: no shards under {args.folders}")
    # Fitted once and read back after: a reshaped mean would silently restate the
    # trust of every label already written.
    args.out.mkdir(parents=True, exist_ok=True)
    kept = args.out / "mean_shape.npy"
    shape = np.load(kept) if kept.is_file() else mean_shape(session, every, args.shape_samples)
    np.save(kept, shape)

    total = trusted = 0
    for shard in every:
        target = args.out / shard.parent.name / f"{shard.stem}.npz"
        if target.is_file():
            continue
        rows, kept = write_shard(session, shard, shape, target)
        total, trusted = total + rows, trusted + kept
        print(f"{shard.parent.name}/{shard.name}  {rows} ban ghi  {kept} tin duoc", flush=True)
    if total:
        print(f"xong: {total} ban ghi, {trusted} tin duoc ({trusted / total * 100:.1f}%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
