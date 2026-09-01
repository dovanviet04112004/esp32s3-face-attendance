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

from .celeba_spoof_parquet import CROP_QUALITY, CROP_SCALES, CROP_SIZE, scaled_box
from .images_to_wds import ShardWriter

DETECT_HW = (120, 160)
DETECT_CONF = 0.3
NUAA_ARCHIVE = "nuaaaa.tar.gz"
NUAA_LIVE_DIR = "ClientRaw"


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
            stem = member.name.split("/raw/", 1)[-1]
            if wanted and stem not in wanted and Path(stem).name not in wanted:
                continue
            handle = tar.extractfile(member)
            if handle is None:
                continue
            yield RawImage(
                name=stem,
                payload=handle.read(),
                is_spoof=NUAA_LIVE_DIR not in stem,
                source="nuaa",
            )


SETS = {"nuaa": nuaa_images}


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


def crops_of(payload: bytes, box: np.ndarray, size: int = CROP_SIZE) -> dict[str, bytes]:
    """Both scales of one face, encoded the way the shard format expects."""
    from PIL import Image

    members: dict[str, bytes] = {}
    with Image.open(io.BytesIO(payload)) as handle:
        image = handle.convert("RGB")
        for name, scale in CROP_SCALES.items():
            patch = image.crop(scaled_box(tuple(box), scale, image.width, image.height))
            buffer = io.BytesIO()
            patch.resize((size, size), Image.BILINEAR).save(
                buffer, format="JPEG", quality=CROP_QUALITY
            )
            members[f"{name}.jpg"] = buffer.getvalue()
    return members


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

    kept = missed = 0
    labels: dict[int, int] = {}
    with ShardWriter(args.out) as writer:
        for raw in SETS[args.set](root, args.split):
            box = best_face(model, priors, raw.payload, device)
            if box is None:
                missed += 1
                continue
            members = crops_of(raw.payload, box)
            members["json"] = json.dumps(
                {"name": raw.name, "label": int(raw.is_spoof), "split": raw.source}
            ).encode()
            writer.add(members)
            kept += 1
            labels[int(raw.is_spoof)] = labels.get(int(raw.is_spoof), 0) + 1

    found = kept / max(kept + missed, 1)
    print(f"{args.set}/{args.split}: kept {kept}, no face in {missed} ({found:.1%} detected)")
    print(f"  live {labels.get(0, 0)}  spoof {labels.get(1, 0)}  -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
