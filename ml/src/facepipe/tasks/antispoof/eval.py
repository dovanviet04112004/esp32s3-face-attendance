"""ACER, HTER and the ROC an anti-spoof model is graded on.

ACER at a fixed threshold cannot rank models: one that separates the classes
perfectly still scores 0.5 with its whole distribution on one side, so the
threshold is fitted here and reported beside the rates it produced. Higher means
more live, and labels follow losses.task_loss: LIVE 0, SPOOF 1.
"""

from __future__ import annotations

import argparse
import io
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch

from .losses.task_loss import LIVE, SPOOF

# The operating points every camera-frame table in measurements.md is read at.
FRAME_THRESHOLDS = (0.50, 0.90, 0.99)
DETECT_HW = (120, 160)
DETECT_CONF = 0.5
FRAME_SUFFIXES = (".jpg", ".jpeg", ".png")


@dataclass(frozen=True)
class ErrorRates:
    """The three rates the branch reports, all at one threshold."""

    apcer: float
    bpcer: float
    acer: float
    threshold: float


def split_scores(scores: np.ndarray, labels: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Liveness scores of the live faces and of the attacks, in that order."""
    scores = np.asarray(scores, dtype=np.float64).ravel()
    labels = np.asarray(labels).ravel()
    if scores.shape != labels.shape:
        raise ValueError(f"{scores.shape} scores against {labels.shape} labels")
    return scores[labels == LIVE], scores[labels != LIVE]


def error_rates(scores: np.ndarray, labels: np.ndarray, threshold: float) -> ErrorRates:
    """APCER, BPCER and their mean, calling a sample live when score >= threshold."""
    live, attack = split_scores(scores, labels)
    apcer = float((attack >= threshold).mean()) if attack.size else 0.0
    bpcer = float((live < threshold).mean()) if live.size else 0.0
    return ErrorRates(apcer, bpcer, (apcer + bpcer) / 2.0, float(threshold))


def equal_error_rate(scores: np.ndarray, labels: np.ndarray) -> ErrorRates:
    """The rates where APCER and BPCER meet, and the threshold that gets there.

    The two rates cross exactly once, and the crossing is separability with the
    operating point taken out. This ranks checkpoints; the shipped threshold is
    a separate decision, made on val and held fixed on test.
    """
    live, attack = split_scores(scores, labels)
    if not live.size or not attack.size:
        return ErrorRates(0.0, 0.0, float("nan"), float("nan"))

    live_sorted, attack_sorted = np.sort(live), np.sort(attack)
    candidates = np.unique(np.concatenate([live_sorted, attack_sorted]))
    accepted = attack_sorted.size - np.searchsorted(attack_sorted, candidates, side="left")
    rejected = np.searchsorted(live_sorted, candidates, side="left")
    apcer = accepted / attack_sorted.size
    bpcer = rejected / live_sorted.size

    best = int(np.argmin(np.abs(apcer - bpcer)))
    return ErrorRates(
        float(apcer[best]),
        float(bpcer[best]),
        float((apcer[best] + bpcer[best]) / 2.0),
        float(candidates[best]),
    )


def auc(scores: np.ndarray, labels: np.ndarray) -> float:
    """Area under the ROC, live as the positive class.

    Computed from rank sums rather than by integrating a sampled curve, so ties
    between equal scores contribute the half they should and the result does not
    depend on how many thresholds were sampled.
    """
    live, attack = split_scores(scores, labels)
    if not live.size or not attack.size:
        return float("nan")

    order = np.concatenate([live, attack]).argsort(kind="mergesort")
    ranks = np.empty(order.size, dtype=np.float64)
    ranks[order] = np.arange(1, order.size + 1, dtype=np.float64)

    ordered = np.concatenate([live, attack])[order]
    start = 0
    for index in range(1, ordered.size + 1):
        if index == ordered.size or ordered[index] != ordered[start]:
            if index - start > 1:
                ranks[order[start:index]] = ranks[order[start:index]].mean()
            start = index

    live_rank_sum = ranks[: live.size].sum()
    return float((live_rank_sum - live.size * (live.size + 1) / 2.0) / (live.size * attack.size))


def summary(scores: np.ndarray, labels: np.ndarray) -> dict[str, float]:
    """The row a validation epoch logs: separability plus the rates behind it."""
    crossing = equal_error_rate(scores, labels)
    return {
        "auc": auc(scores, labels),
        "eer": crossing.acer,
        "apcer": crossing.apcer,
        "bpcer": crossing.bpcer,
        "threshold": crossing.threshold,
    }


def liveness_of(output: torch.Tensor) -> torch.Tensor:
    """One score per sample, read here rather than by each caller.

    Every caller must read the same head the same way, or two numbers that look
    comparable are not.
    """
    return output.softmax(dim=1)[:, LIVE]


@torch.no_grad()
def collect_scores(
    model: torch.nn.Module, loader: Iterable, device: torch.device
) -> tuple[np.ndarray, np.ndarray]:
    """Run one split through the model and return its scores beside its labels."""
    model.eval()
    scores: list[np.ndarray] = []
    truth: list[np.ndarray] = []
    for tight, wide, labels, _wide_scale in loader:
        output = model((tight.to(device), wide.to(device)))
        scores.append(liveness_of(output).float().cpu().numpy())
        truth.append(labels.numpy())
    return np.concatenate(scores), np.concatenate(truth)


def build_loader(cfg: object, split: str, root: Path | None = None) -> torch.utils.data.DataLoader:
    """The named split, read the way training reads it but without shuffling.

    root overrides where the shards live, which is how a cross-domain set is read
    through exactly the same path as the one a run was trained and validated on.
    """
    from .data import SpoofShardDataset, collate

    height, width = cfg.model.input_hw
    if height != width:
        raise ValueError(f"model.input_hw must be square for this branch, got {height}x{width}")
    dataset = SpoofShardDataset(
        root=Path(root or cfg.data.params["shards"]),
        size=int(height),
        train=False,
        seed=cfg.run.seed,
        splits=split,
    )
    return torch.utils.data.DataLoader(
        dataset,
        batch_size=cfg.data.batch_size,
        num_workers=cfg.data.num_workers,
        collate_fn=collate,
    )


def load_run(run: Path) -> tuple[object, torch.nn.Module]:
    """Rebuild a run's model from the config it froze, preferring its EMA copy."""
    from facepipe.core.config import load_run_config
    from facepipe.core.registry import MODELS

    from .model import minifasnet_v2_se  # noqa: F401  registers the model

    cfg = load_run_config(run)
    # best.pth appears only after the first validation, so a run stopped inside
    # its first epochs has nothing but last.pth.
    path = run / "ckpt" / "best.pth"
    if not path.is_file():
        path = run / "ckpt" / "last.pth"
    payload = torch.load(path, map_location="cpu", weights_only=False)
    state = payload["ema"]["module"] if "ema" in payload else payload["model"]
    params = dict(cfg.model.params)
    # A config without a views key belongs to a two-view run; its weights say so.
    params.setdefault("views", "both" if any(k.startswith("wide.") for k in state) else "tight")
    model = MODELS.build({"name": cfg.model.name, "params": params})
    model.load_state_dict(state)
    return cfg, model


def export_spec(run: Path, model: torch.nn.Module | None = None):
    """The module to trace, one example input, and the names of both ends.

    model overrides the run's own weights, which is how the quantisation
    passes export the graph they just rewrote.
    """
    from facepipe.core.config import load_run_config

    cfg = load_run_config(run)
    model = model if model is not None else load_run(run)[1]
    model.eval()
    height, width = cfg.model.input_hw
    names = input_names(cfg)
    views = tuple(torch.zeros(1, 3, height, width) for _ in names)
    example = views if len(names) > 1 else views[0]
    return cfg, model, (example,), names, ["logits"]


def input_names(cfg: object) -> list[str]:
    """The graph's inputs in order: the face crop, and the context crop if the model has one."""
    both = (cfg.model.params or {}).get("views", "tight") == "both"
    return ["tight", "wide"] if both else ["tight"]


def frame_label(folder: str) -> int:
    """LIVE for a folder named live_*, SPOOF for anything else."""
    return LIVE if folder.startswith("live") else SPOOF


def load_detector(ckpt: Path, device: torch.device):
    """The detection student and its priors, for finding the face in a whole frame."""
    from facepipe.tasks.detection.eval import load_model
    from facepipe.tasks.detection.model.anchors import feature_sizes, pyramid_priors
    from facepipe.tasks.detection.model.yunet import STRIDES

    model = load_model(ckpt).to(device).eval()
    priors = torch.cat(pyramid_priors(feature_sizes(DETECT_HW, STRIDES), STRIDES)).to(device)
    return model, priors


@torch.no_grad()
def largest_face(
    detector, priors, frame_rgb: np.ndarray, device: torch.device
) -> np.ndarray | None:
    """The biggest box in one frame, in that frame's pixels, or None."""
    from PIL import Image

    from facepipe.tasks.detection.data import letterbox_params
    from facepipe.tasks.detection.eval import decode_batch, to_original

    height, width = frame_rgb.shape[:2]
    scale, pad_x, pad_y = letterbox_params((height, width), DETECT_HW)
    canvas = Image.new("RGB", (DETECT_HW[1], DETECT_HW[0]))
    canvas.paste(
        Image.fromarray(frame_rgb).resize((round(width * scale), round(height * scale))),
        (pad_x, pad_y),
    )
    tensor = torch.from_numpy(np.asarray(canvas, dtype=np.float32) / 255.0).permute(2, 0, 1)[None]
    found = decode_batch(detector(tensor.to(device)), priors, conf=DETECT_CONF)[0]
    if not len(found.boxes):
        return None
    boxes = to_original(found, scale, pad_x, pad_y).boxes
    sides = np.maximum(boxes[:, 2] - boxes[:, 0], boxes[:, 3] - boxes[:, 1])
    return boxes[int(np.argmax(sides))]


def crop_views(frame_rgb: np.ndarray, box: np.ndarray, size: int) -> tuple[np.ndarray, np.ndarray]:
    """Both scales of one face, through the JPEG round trip the shards were cut with."""
    from PIL import Image

    from facepipe.data.prepare.celeba_spoof_parquet import (
        CROP_QUALITY,
        CROP_SCALES,
        crop_sizes,
        fitted_box,
    )

    image = Image.fromarray(frame_rgb)
    sizes = crop_sizes()
    views = []
    for name, scale in CROP_SCALES.items():
        crop, _ = fitted_box(tuple(box), scale, image.width, image.height)
        buffer = io.BytesIO()
        image.crop(crop).resize((sizes[name], sizes[name]), Image.BILINEAR).save(
            buffer, format="JPEG", quality=CROP_QUALITY
        )
        buffer.seek(0)
        with Image.open(buffer) as handle:
            views.append(
                np.array(handle.convert("RGB").resize((size, size), Image.BILINEAR), dtype=np.uint8)
            )
    return views[0], views[1]


@torch.no_grad()
def score_frames(
    model: torch.nn.Module, detector, priors, root: Path, size: int, device: torch.device
) -> list[tuple[str, str, float, float]]:
    """One (folder, file, liveness, face side px) per frame; no face scores nan.

    The side is what KEHOACH 3 turns into a distance, so a report can be read
    on the range the branch serves instead of on every frame in the folder.
    """
    from PIL import Image

    def as_batch(image: np.ndarray) -> torch.Tensor:
        return torch.from_numpy(image).permute(2, 0, 1).float().div_(255.0)[None].to(device)

    model.eval()
    rows: list[tuple[str, str, float, float]] = []
    for folder in sorted(p for p in root.iterdir() if p.is_dir()):
        for path in sorted(p for p in folder.iterdir() if p.suffix.lower() in FRAME_SUFFIXES):
            with Image.open(path) as handle:
                frame = np.array(handle.convert("RGB"), dtype=np.uint8)
            box = largest_face(detector, priors, frame, device)
            if box is None:
                rows.append((folder.name, path.name, float("nan"), float("nan")))
                continue
            tight, wide = crop_views(frame, box, size)
            side = float(max(box[2] - box[0], box[3] - box[1]))
            rows.append(
                (
                    folder.name,
                    path.name,
                    float(liveness_of(model((as_batch(tight), as_batch(wide))))[0]),
                    side,
                )
            )
    return rows


def report_frames(
    rows: list[tuple[str, str, float, float]], thresholds: Iterable[float], min_face_px: float = 0.0
) -> None:
    """Per-folder pass counts and the three rates at every threshold, the measurements.md layout."""
    thresholds = tuple(thresholds)
    kept = [row for row in rows if not np.isnan(row[2]) and row[3] >= min_face_px]
    scored = [(folder, score) for folder, _file, score, _side in kept]
    sides = {folder: [side for f, _n, _s, side in kept if f == folder] for folder, _s in scored}
    missed = len(rows) - len(scored)
    scores = np.array([s for _f, s in scored], dtype=np.float64)
    labels = np.array([frame_label(f) for f, _s in scored], dtype=np.int64)
    print(
        f"frames {len(rows)}, scored {len(scored)}, dropped {missed} "
        f"(no face, or side under {min_face_px:.0f} px)"
    )
    header = "  ".join(f"@{t:.2f}" for t in thresholds)
    print(f"{'folder':14s} {'n':>3s}  {'side px':>13s}  {header}")
    for folder in sorted({f for f, _s in scored}):
        own = np.array([s for f, s in scored if f == folder])
        live = frame_label(folder) == LIVE
        passes = "  ".join(
            f"{int((own >= t).sum()) if live else int((own < t).sum()):>3d}/{own.size:<2d}"
            for t in thresholds
        )
        span = sides[folder]
        reach = f"{int(min(span)):>4d}-{int(max(span)):<4d}" if span else "    -    "
        print(
            f"{folder:14s} {own.size:>3d}  {reach:>13s}  {passes}   {'pass' if live else 'blocked'}"
        )
    print(f"{'threshold':14s} {'bpcer':>8s} {'apcer':>8s} {'ACER':>8s}")
    for threshold in thresholds:
        rates = error_rates(scores, labels, threshold)
        print(f"{threshold:<14.2f} {rates.bpcer:8.4f} {rates.apcer:8.4f} {rates.acer:8.4f}")
    crossing = equal_error_rate(scores, labels)
    print(f"eer {crossing.acer:.4f} at {crossing.threshold:.4f}, auc {auc(scores, labels):.4f}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True, help="a run directory under artifacts")
    parser.add_argument("--split", default=None, help="the split the reported rates come from")
    parser.add_argument("--fit-split", default=None, help="where the threshold is fitted")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument(
        "--xdomain",
        type=Path,
        action="append",
        default=[],
        help="a shard directory from another dataset, scored at the same threshold",
    )
    parser.add_argument(
        "--frames",
        type=Path,
        default=None,
        help="a folder of live_*/attack_* folders of whole camera frames, run through the detector",
    )
    parser.add_argument(
        "--detector", type=Path, default=None, help="detection checkpoint, needed with --frames"
    )
    parser.add_argument(
        "--min-face-px",
        type=float,
        default=0.0,
        help="drop frames whose face is narrower than this, the served range of KEHOACH 3",
    )
    args = parser.parse_args(argv)

    device = torch.device(args.device)
    cfg, model = load_run(args.run)
    model = model.to(device)
    if args.frames is not None:
        if args.detector is None:
            parser.error("--frames needs --detector")
        detector, priors = load_detector(args.detector, device)
        rows = score_frames(
            model, detector, priors, args.frames, int(cfg.model.input_hw[0]), device
        )
        report_frames(rows, FRAME_THRESHOLDS, args.min_face_px)
        return 0
    # The run's own splits, so a report cannot rest on a division it never saw.
    fit_split = args.fit_split or cfg.data.params["val_split"]
    held_split = args.split or cfg.data.params["test_split"]

    fit = collect_scores(model, build_loader(cfg, fit_split), device)
    crossing = equal_error_rate(*fit)
    print(f"{fit_split:12s} n={fit[0].size:<7} auc {auc(*fit):.4f}  eer {crossing.acer:.4f}")
    print(f"       threshold fitted here: {crossing.threshold:.6f}")

    held = collect_scores(model, build_loader(cfg, held_split), device)
    rates = error_rates(*held, crossing.threshold)
    print(f"\n{held_split:12s} n={held[0].size:<7} auc {auc(*held):.4f}")
    print(f"       apcer {rates.apcer:.4f}  bpcer {rates.bpcer:.4f}  ACER {rates.acer:.4f}")
    print(f"       eer   {equal_error_rate(*held).acer:.4f}  (not the gate, the threshold moved)")

    for shards in args.xdomain:
        # HTER is these rates at the home set's own threshold: refitting here
        # would report how separable the other set is, not how well this transfers.
        other = collect_scores(model, build_loader(cfg, ".", root=shards), device)
        live, attack = split_scores(*other)
        rates = error_rates(*other, crossing.threshold)
        print(f"\n{shards.name:24s} n={other[0].size:<6} live {live.size:<5} attack {attack.size}")
        if not live.size or not attack.size:
            rate, name = (rates.apcer, "apcer") if attack.size else (rates.bpcer, "bpcer")
            print(f"       {name} {rate:.4f}   (one class only: no auc, no HTER)")
            continue
        print(f"       auc {auc(*other):.4f}  apcer {rates.apcer:.4f}  bpcer {rates.bpcer:.4f}")
        print(f"       HTER {rates.acer:.4f}   eer {equal_error_rate(*other).acer:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
