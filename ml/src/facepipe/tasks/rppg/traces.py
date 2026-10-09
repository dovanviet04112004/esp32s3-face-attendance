"""Video → per-frame mean colour of each skin region, once per path (KEHOACH 3).

The native path reads every source frame; each board path samples at the board's
frame rate and sees the face as `board_path` draws it. Faces come from the detector
the board runs, found once per detector period and held in between, as on the board.
"""

from __future__ import annotations

import argparse
import time
import zlib
from pathlib import Path

import numpy as np

from .board_path import board_view
from .config import RppgConfig, data_path, load_config
from .data import Clip, axon_clips, unique_clips
from .roi import region_boxes, region_means

NATIVE = "native"


def all_clips() -> list[Clip]:
    """Both sets, refusing to go on when one of them yields nothing to score."""
    sets = {
        "unique_pair": unique_clips(data_path("antispoof.xdomain.unique_pair")),
        "axon_masks": axon_clips(data_path("antispoof.xdomain.axon_masks")),
    }
    for name, clips in sets.items():
        if not clips:
            raise SystemExit(f"{name}: no video found; check the paths.yaml entry and its links")
    return [clip for clips in sets.values() for clip in clips]


def trace_file(path_name: str, clip: Clip) -> Path:
    return data_path("rppg.traces") / path_name / clip.source / f"{clip.name}.npz"


def detect(model, priors, rgb: np.ndarray, device: str) -> tuple[np.ndarray, np.ndarray] | None:
    """The best face's box and five landmarks, letterboxed exactly as xdomain_crop does."""
    import torch
    from PIL import Image

    from facepipe.data.prepare.xdomain_crop import DETECT_CONF, DETECT_HW
    from facepipe.tasks.detection.data import letterbox_params
    from facepipe.tasks.detection.eval import decode_batch, to_original

    height, width = rgb.shape[:2]
    scale, pad_x, pad_y = letterbox_params((height, width), DETECT_HW)
    canvas = Image.new("RGB", (DETECT_HW[1], DETECT_HW[0]))
    canvas.paste(
        Image.fromarray(rgb).resize((round(width * scale), round(height * scale))), (pad_x, pad_y)
    )
    array = np.asarray(canvas, dtype=np.float32)[None] / 255.0
    tensor = torch.from_numpy(array).permute(0, 3, 1, 2).to(device)
    with torch.no_grad():
        found = decode_batch(model(tensor), priors, conf=DETECT_CONF)[0]
    if not len(found.boxes):
        return None
    original = to_original(found, scale, pad_x, pad_y)
    best = int(np.argmax(original.scores))
    return original.boxes[best], original.landmarks[best]


def extract(
    clip: Clip, cfg: RppgConfig, model, priors, device: str
) -> dict[str, dict[str, np.ndarray]]:
    """Every path's samples for one clip: times, region means, and the face width seen."""
    import cv2

    capture = cv2.VideoCapture(str(clip.path))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    duration = int(capture.get(cv2.CAP_PROP_FRAME_COUNT)) / fps
    first, last = cfg.edge * duration, (1.0 - cfg.edge) * duration
    paths = {NATIVE: 0, **{name: spec.face_px for name, spec in cfg.board_paths.items()}}
    samples: dict[str, list[tuple[float, np.ndarray, float]]] = {name: [] for name in paths}
    rngs = {
        name: np.random.default_rng(
            [cfg.seed, zlib.crc32(f"{clip.source}/{clip.name}/{name}".encode())]
        )
        for name in paths
    }
    held, last_detect, tick, index, detections = None, -np.inf, first, -1, 0
    try:
        while True:
            ok, bgr = capture.read()
            if not ok:
                break
            index += 1
            stamp = capture.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            t = stamp if stamp > 0 or index == 0 else index / fps
            if t < first:
                continue
            if t > last:
                break
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            if t - last_detect >= cfg.detector_period_s:
                last_detect = t
                found = detect(model, priors, rgb, device)
                if found is not None:
                    held, detections = found, detections + 1
            # Board frames due by now take this one; with no face held they are lost, as on board.
            due = []
            while tick <= t:
                due.append(tick)
                tick += 1.0 / cfg.board_fps
            if held is None:
                continue
            box, landmarks = held
            boxes = region_boxes(landmarks, cfg.regions)
            samples[NATIVE].append((t, region_means(rgb, boxes) / 255.0, float(box[2] - box[0])))
            if not due:
                continue
            for name, face_px in paths.items():
                if name == NATIVE:
                    continue
                view, origin, scale = board_view(rgb, box, face_px, cfg.board_noise_lsb, rngs[name])
                means = region_means(view, (boxes - np.tile(origin, 2)) * scale)
                samples[name] += [(when, means, float(face_px)) for when in due]
    finally:
        capture.release()
    return {
        name: {
            "t": np.array([row[0] for row in rows], dtype=np.float64),
            "rgb": np.array([row[1] for row in rows], dtype=np.float32).reshape(
                -1, len(cfg.regions), 3
            ),
            "face_w": np.array([row[2] for row in rows], dtype=np.float32),
            "fps_source": np.float64(fps),
            "detections": np.int64(detections),
        }
        for name, rows in samples.items()
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cfg", type=Path, default=Path("configs/rppg/rppg.yaml"))
    parser.add_argument("--only", choices=("all", "unique", "axon"), default="all")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args(argv)

    import cv2
    import torch

    from facepipe.data.prepare.xdomain_crop import load_detector

    torch.set_num_threads(args.threads)
    cv2.setNumThreads(args.threads)
    cfg = load_config(args.cfg)
    clips = [c for c in all_clips() if args.only == "all" or c.source.startswith(args.only)]
    if args.limit:
        clips = clips[: args.limit]
    model, priors = load_detector(data_path("antispoof.detector"), args.device)
    names = [NATIVE, *cfg.board_paths]
    for number, clip in enumerate(clips, 1):
        if not args.overwrite and all(trace_file(name, clip).exists() for name in names):
            continue
        began = time.monotonic()
        traces = extract(clip, cfg, model, priors, args.device)
        for name, arrays in traces.items():
            out = trace_file(name, clip)
            out.parent.mkdir(parents=True, exist_ok=True)
            np.savez_compressed(
                out,
                regions=np.array(list(cfg.regions)),
                kind=clip.kind,
                source=clip.source,
                person=clip.person,
                video=str(clip.path),
                **arrays,
            )
        native = traces[NATIVE]
        print(
            f"[{number}/{len(clips)}] {clip.source}/{clip.name}: {len(native['t'])} frames, "
            f"{int(native['detections'])} detections, {time.monotonic() - began:.1f} s",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
