"""Cross-domain sets to shards, with faces found the way the device finds them.

The four sets ship as photographs and video, not as the two 80x80 crops this
branch reads. A crop the kiosk could not have produced is not a fair test, so
faces come from the detection branch's own student rather than from a ground
truth box the device will never have.

CelebA-Spoof holds no label for the kind of attack, so which attacks a model
fails on can only come from sets that do (KEHOACH section 1.2).

Usage:
    python -m facepipe.data.prepare.xdomain_crop --set nuaa \\
        --detector artifacts/detection/runs/<run>/ckpt/best.pth \\
        --out data/interim/antispoof/xdomain/nuaa_crops
"""

from __future__ import annotations

import argparse
import io
import json
import tarfile
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .celeba_spoof_parquet import (
    CROP_QUALITY,
    CROP_SCALES,
    CROP_SIZE,
    WIDE_SIZE,
    crop_sizes,
    face_within,
    fitted_box,
)
from .images_to_wds import ShardWriter

DETECT_HW = (120, 160)
DETECT_CONF = 0.3
NUAA_ARCHIVE = "nuaaaa.tar.gz"
NUAA_LIVE_DIR = "ClientRaw"
AXON_LIVE_DIR = "Selfies"
AXON_FRAMES = 8


@dataclass
class RawImage:
    """One source image, its label, and where it came from."""

    name: str
    payload: bytes
    is_spoof: bool
    source: str


def nuaa_images(root: Path, split: str = "test") -> Iterator[RawImage]:
    """Stream NUAA straight out of its archive, labelled by the folder it sits in.

    ImposterRaw holds printed photographs held up to the camera and ClientRaw the
    live captures, which is the whole labelling the set carries.
    """
    index = Path(root) / split / "train-00000-of-00001.parquet"
    if not index.is_file():
        raise FileNotFoundError(f"{index}: no parquet index for split {split!r}")

    import pyarrow.parquet as pq

    wanted = {str(row["filename"]) for row in pq.read_table(index).to_pylist()}
    archive = Path(root) / NUAA_ARCHIVE
    with tarfile.open(archive, "r|gz") as tar:
        for member in tar:
            if not member.isfile() or not member.name.lower().endswith(".jpg"):
                continue
            if member.name not in wanted:
                continue
            handle = tar.extractfile(member)
            if handle is None:
                continue
            yield RawImage(
                name=member.name,
                payload=handle.read(),
                is_spoof=NUAA_LIVE_DIR not in member.name,
                source="nuaa",
            )


def video_frames(path: Path, count: int = AXON_FRAMES) -> Iterator[bytes]:
    """A few frames spread across one clip, encoded as JPEG.

    Neighbouring frames of a video are near duplicates, so taking them evenly
    across the clip buys variety that taking the first N does not.
    """
    import cv2

    capture = cv2.VideoCapture(str(path))
    try:
        total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        if total <= 0:
            return
        for index in np.linspace(0, total - 1, num=min(count, total), dtype=int):
            capture.set(cv2.CAP_PROP_POS_FRAMES, int(index))
            ok, frame = capture.read()
            if not ok:
                continue
            encoded, payload = cv2.imencode(".jpg", frame)
            if encoded:
                yield payload.tobytes()
    finally:
        capture.release()


def axon_images(root: Path, split: str = "test") -> Iterator[RawImage]:
    """Every attack folder as its own source, and the selfies as the live one.

    The folder name is the only attack label any of the four sets carries, which
    is the whole reason this set is worth the frame decoding (KEHOACH 1.2).
    """
    for folder in sorted(Path(root).iterdir()):
        if not folder.is_dir():
            continue
        source = folder.name.strip().replace(" ", "_").lower()
        is_spoof = folder.name != AXON_LIVE_DIR
        for path in sorted(folder.rglob("*")):
            if not path.is_file():
                continue
            suffix = path.suffix.lower()
            if suffix in {".jpg", ".jpeg", ".png"}:
                yield RawImage(path.name, path.read_bytes(), is_spoof, source)
            elif suffix in {".mp4", ".mov"}:
                for number, payload in enumerate(video_frames(path)):
                    yield RawImage(f"{path.stem}_{number}", payload, is_spoof, source)


SETS = {"nuaa": nuaa_images, "axon": axon_images}


def load_detector(ckpt: Path, device: str):
    """The detection student and its priors, ready to run on one image at a time."""
    import torch

    from facepipe.tasks.detection.eval import load_student
    from facepipe.tasks.detection.student.anchors import feature_sizes, pyramid_priors
    from facepipe.tasks.detection.student.yunet import STRIDES

    model = load_student(Path(ckpt)).to(device).eval()
    priors = torch.cat(pyramid_priors(feature_sizes(DETECT_HW, STRIDES), STRIDES)).to(device)
    return model, priors


def best_face(model, priors, payload: bytes, device: str) -> np.ndarray | None:
    """The highest scoring face in one image, in that image's own pixels."""
    import torch
    from PIL import Image

    from facepipe.tasks.detection.data import letterbox_params
    from facepipe.tasks.detection.eval import decode_batch, to_original

    with Image.open(io.BytesIO(payload)) as handle:
        image = handle.convert("RGB")
        width, height = image.size
        scale, pad_x, pad_y = letterbox_params((height, width), DETECT_HW)
        canvas = Image.new("RGB", (DETECT_HW[1], DETECT_HW[0]))
        canvas.paste(image.resize((round(width * scale), round(height * scale))), (pad_x, pad_y))

    tensor = torch.from_numpy(np.asarray(canvas, dtype=np.float32) / 255.0)
    tensor = tensor.permute(2, 0, 1)[None].to(device)
    with torch.no_grad():
        found = decode_batch(model(tensor), priors, conf=DETECT_CONF)[0]
    if not len(found.boxes):
        return None
    original = to_original(found, scale, pad_x, pad_y)
    return original.boxes[int(np.argmax(original.scores))]


def crops_of(
    payload: bytes, box: np.ndarray, size: int = CROP_SIZE, wide_size: int = WIDE_SIZE
) -> tuple[dict[str, bytes], float, list[float]]:
    """Both scales of one face, encoded the way the shard format expects."""
    from PIL import Image

    members: dict[str, bytes] = {}
    reached: dict[str, float] = {}
    sizes = crop_sizes(size, wide_size)
    face_in_wide: list[float] = []
    with Image.open(io.BytesIO(payload)) as handle:
        image = handle.convert("RGB")
        for name, scale in CROP_SCALES.items():
            crop, reached[name] = fitted_box(tuple(box), scale, image.width, image.height)
            if name == "wide":
                face_in_wide = face_within(tuple(int(v) for v in box), crop)
            edge = sizes[name]
            patch = image.crop(crop)
            buffer = io.BytesIO()
            patch.resize((edge, edge), Image.BILINEAR).save(
                buffer, format="JPEG", quality=CROP_QUALITY
            )
            members[f"{name}.jpg"] = buffer.getvalue()
    return members, reached["wide"], face_in_wide


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--set", choices=sorted(SETS), required=True)
    parser.add_argument("--root", type=Path, default=None)
    parser.add_argument("--split", default="test")
    parser.add_argument("--detector", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--device", default=None)
    args = parser.parse_args(argv)

    import torch

    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    root = args.root or Path("data/raw/antispoof/xdomain") / args.set
    model, priors = load_detector(args.detector, device)

    writers: dict[str, ShardWriter] = {}
    kept: dict[str, int] = {}
    missed = 0
    try:
        for raw in SETS[args.set](root, args.split):
            box = best_face(model, priors, raw.payload, device)
            if box is None:
                missed += 1
                continue
            if raw.source not in writers:
                writers[raw.source] = ShardWriter(args.out / raw.source).__enter__()
            members, wide_scale, face_in_wide = crops_of(raw.payload, box)
            members["json"] = json.dumps(
                {
                    "name": raw.name,
                    "label": int(raw.is_spoof),
                    "split": raw.source,
                    "wide_scale": round(wide_scale, 4),
                    "face_in_wide": face_in_wide,
                }
            ).encode()
            writers[raw.source].add(members)
            kept[raw.source] = kept.get(raw.source, 0) + 1
    finally:
        for writer in writers.values():
            writer.__exit__(None, None, None)

    total = sum(kept.values())
    found = total / max(total + missed, 1)
    print(f"{args.set}/{args.split}: kept {total}, no face in {missed} ({found:.1%} detected)")
    for source, count in sorted(kept.items()):
        print(f"  {source:36s} {count:>5}  -> {args.out / source}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
