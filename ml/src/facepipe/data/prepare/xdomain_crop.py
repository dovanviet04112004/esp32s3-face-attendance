"""Cross-domain sets to shards, with faces found the way the device finds them.

Faces come from the detection branch, not from a ground truth box the device
will never have: a crop the kiosk could not produce is not a fair test.
CelebA-Spoof carries no attack-type label, so which attacks a model fails on can
only come from sets that do (KEHOACH 1.2).
"""

from __future__ import annotations

import argparse
import io
import itertools
import json
import tarfile
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
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
UNIQUE_LIVE_DIR = "live"
UNIQUE_REPLAY_DIR = "replay"
UNIQUE_MANIFEST = "anti-spoofing_replay.csv"
UNIQUE_FRAMES = 60
# A player's first frame paints a play button over the face, and the last frame
# is often black; both would become the label (measurements/antispoof 40.6).
UNIQUE_EDGE = 0.2
# Of 30 people, held out whole: a person on both sides makes val read high.
UNIQUE_VAL_EVERY = 5


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


def video_frames(path: Path, count: int = AXON_FRAMES, edge: float = 0.0) -> Iterator[bytes]:
    """A few frames spread across one clip as JPEG, `edge` of it dropped each end.

    Neighbouring frames are near duplicates, so spreading them evenly buys
    variety that taking the first N does not.
    """
    import cv2

    capture = cv2.VideoCapture(str(path))
    try:
        total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        if total <= 0:
            return
        first, last = total * edge, (total - 1) * (1.0 - edge)
        for index in np.linspace(first, last, num=min(count, total), dtype=int):
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


def unique_pairs(root: Path) -> list[tuple[str, str]]:
    """Each live folder with the replay folder filmed from it, per the manifest."""
    lines = (Path(root) / UNIQUE_MANIFEST).read_text(encoding="utf-8").splitlines()
    pairs = [line.split(";") for line in lines[1:] if line.strip()]
    return sorted((row[0], Path(row[2]).parent.name) for row in pairs if len(row) >= 3 and row[2])


def unique_images(root: Path, split: str = "train") -> Iterator[RawImage]:
    """Paired live and replay clips of one person, held out whole by person.

    The two sides differ only by the screen between face and lens, so photo
    style cannot separate them and the model has to read the screen itself.
    """
    root = Path(root)
    for index, ids in enumerate(unique_pairs(root)):
        if (split == "val") != (index % UNIQUE_VAL_EVERY == 0):
            continue
        for folder, name, is_spoof in (
            (UNIQUE_LIVE_DIR, ids[0], False),
            (UNIQUE_REPLAY_DIR, ids[1], True),
        ):
            for path in sorted((root / folder / name).glob("*")):
                if path.suffix.lower() not in {".mp4", ".mov"}:
                    continue
                for number, payload in enumerate(video_frames(path, UNIQUE_FRAMES, UNIQUE_EDGE)):
                    yield RawImage(f"{name}_{number}", payload, is_spoof, f"{split}/{folder}")


LCC_SPLITS = {"train": "training", "val": "development", "test": "evaluation"}
LCC_LIVE_DIR = "real"
SYNTH_LIVE_DIR = "BonaFide"
SYNTH_ATTACK_DIR = "PAs"
# Per channel, spaced evenly through the folder: 2 000 resolves APCER to 0.05%.
SYNTH_TEST_CAP = 2000
# Per channel from what test did not take, sized by how much of that channel the
# model still gets wrong (measurements/antispoof 40.5).
SYNTH_TRAIN_CAPS = {
    "BonaFide": 23000,
    "iPad_ReplayAttack": 23000,
    "Samsung_ReplayAttack": 6000,
    "Webcam_ReplayAttack": 6000,
    "PrintAttack": 2000,
}
SYNTH_TRAIN_CAP = 6000
DETECT_BATCH = 64
DECODE_THREADS = 8


def lcc_paths(root: Path, split: str) -> list[Path]:
    """Every image of one LCC-FASD split, real folder first."""
    folder = Path(root) / "LCC_FASD" / f"LCC_FASD_{LCC_SPLITS[split]}"
    if not folder.is_dir():
        raise FileNotFoundError(f"{folder}: no LCC-FASD split {split!r}")
    return [
        path
        for label_dir in sorted(p for p in folder.iterdir() if p.is_dir())
        for path in sorted(label_dir.glob("*.png"))
    ]


def lcc_images(root: Path, split: str = "test") -> Iterator[RawImage]:
    """One LCC-FASD split as one source, labelled by its real/spoof folder."""
    for path in lcc_paths(root, split):
        is_spoof = path.parent.name != LCC_LIVE_DIR
        yield RawImage(path.name, path.read_bytes(), is_spoof, LCC_SPLITS[split])


def spaced(count: int, cap: int) -> list[int]:
    return np.linspace(0, count - 1, num=min(cap, count), dtype=int).tolist()


def synthaspoof_paths(root: Path, split: str) -> list[tuple[Path, str]]:
    """The images one SynthASpoof split takes, each with the source it lands in.

    Both splits keep the channel as its own source, so a pool can weight the
    channel the model fails on without dragging the solved ones up with it.
    """
    base = Path(root) / "SynthASpoof"
    folders = [base / SYNTH_LIVE_DIR]
    folders += sorted(p for p in (base / SYNTH_ATTACK_DIR).iterdir() if p.is_dir())
    chosen: list[tuple[Path, str]] = []
    for folder in folders:
        paths = sorted(folder.glob("*.png"))
        test_picks = spaced(len(paths), SYNTH_TEST_CAP)
        source = f"{split}/{folder.name.lower()}"
        if split == "test":
            chosen += [(paths[i], source) for i in test_picks]
        else:
            rest = sorted(set(range(len(paths))) - set(test_picks))
            cap = SYNTH_TRAIN_CAPS.get(folder.name, SYNTH_TRAIN_CAP)
            chosen += [(paths[rest[i]], source) for i in spaced(len(rest), cap)]
    return chosen


def synthaspoof_images(root: Path, split: str = "test") -> Iterator[RawImage]:
    """BonaFide against every PAs channel, split as synthaspoof_paths decides."""
    for path, source in synthaspoof_paths(root, split):
        is_spoof = path.parent.name != SYNTH_LIVE_DIR
        yield RawImage(path.name, path.read_bytes(), is_spoof, source)


SETS = {
    "nuaa": nuaa_images,
    "axon": axon_images,
    "lcc_fasd": lcc_images,
    "synthaspoof": synthaspoof_images,
    "unique": unique_images,
}


def load_detector(ckpt: Path, device: str):
    """The detection model and its priors, ready to run on one image at a time."""
    import torch

    from facepipe.tasks.detection.eval import load_model
    from facepipe.tasks.detection.model.anchors import feature_sizes, pyramid_priors
    from facepipe.tasks.detection.model.yunet import STRIDES

    model = load_model(Path(ckpt)).to(device).eval()
    priors = torch.cat(pyramid_priors(feature_sizes(DETECT_HW, STRIDES), STRIDES)).to(device)
    return model, priors


def detector_input(payload: bytes):
    """One image letterboxed to the detector's size, with the mapping back.

    Split out from the forward pass so a caller can decode many images across a
    pool while the model still sees them as one batch.
    """
    from PIL import Image

    from facepipe.tasks.detection.data import letterbox_params

    with Image.open(io.BytesIO(payload)) as handle:
        image = handle.convert("RGB")
        width, height = image.size
        scale, pad_x, pad_y = letterbox_params((height, width), DETECT_HW)
        canvas = Image.new("RGB", (DETECT_HW[1], DETECT_HW[0]))
        canvas.paste(image.resize((round(width * scale), round(height * scale))), (pad_x, pad_y))
    return np.asarray(canvas, dtype=np.float32) / 255.0, (scale, pad_x, pad_y)


def best_faces(model, priors, prepared, device: str):
    """The highest scoring face per image, in each image's own pixels."""
    import torch

    from facepipe.tasks.detection.eval import decode_batch, to_original

    canvases = np.stack([canvas for canvas, _ in prepared])
    tensor = torch.from_numpy(canvases).permute(0, 3, 1, 2).to(device)
    with torch.no_grad():
        batch = decode_batch(model(tensor), priors, conf=DETECT_CONF)
    boxes = []
    for found, (_, mapping) in zip(batch, prepared, strict=True):
        if not len(found.boxes):
            boxes.append(None)
            continue
        original = to_original(found, *mapping)
        boxes.append(original.boxes[int(np.argmax(original.scores))])
    return boxes


def best_face(model, priors, payload: bytes, device: str) -> np.ndarray | None:
    """The highest scoring face in one image, in that image's own pixels."""
    return best_faces(model, priors, [detector_input(payload)], device)[0]


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
    images = SETS[args.set](root, args.split)
    # Decoding is the slow half, so a pool decodes a batch while the GPU sees it whole.
    with ThreadPoolExecutor(max_workers=DECODE_THREADS) as pool:
        try:
            while chunk := list(itertools.islice(images, DETECT_BATCH)):
                prepared = list(pool.map(lambda raw: detector_input(raw.payload), chunk))
                boxes = best_faces(model, priors, prepared, device)
                found = [(raw, box) for raw, box in zip(chunk, boxes, strict=True) if box is not None]
                missed += len(chunk) - len(found)
                cropped = list(pool.map(lambda pair: crops_of(pair[0].payload, pair[1]), found))
                for (raw, _), (members, wide_scale, face_in_wide) in zip(found, cropped, strict=True):
                    if raw.source not in writers:
                        writers[raw.source] = ShardWriter(args.out / raw.source).__enter__()
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
