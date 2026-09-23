"""Verification accuracy on the standard benchmarks, and TAR at a fixed FAR.

InsightFace's protocol: pairs come from a .bin of encoded images and a
same-or-not flag, similarity is cosine between L2-normalised embeddings, and the
threshold is fitted on nine folds and scored on the tenth. The flip test is off
by default - published figures use it, the device does not.
"""

from __future__ import annotations

import argparse
import io
import pickle
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from .data import ALIGNED_SIZE

BENCHMARKS = ("lfw", "cfp_fp", "agedb_30")
FOLDS = 10
THRESHOLD_STEPS = 4001
FAR_TARGETS = (1e-3, 1e-4)
BATCH_SIZE = 256


def read_bin(path: Path) -> tuple[list[bytes], np.ndarray]:
    """Encoded images and the same-or-not flag per pair, in InsightFace's layout."""
    with Path(path).open("rb") as handle:
        payload = pickle.load(handle, encoding="bytes")
    encoded, issame = payload[0], payload[1]
    return list(encoded), np.asarray(issame, dtype=bool)


def decode_images(encoded: list[bytes], size: int = ALIGNED_SIZE) -> np.ndarray:
    """Decode to one uint8 array, pairs sitting at 2i and 2i+1."""
    out = np.zeros((len(encoded), size, size, 3), dtype=np.uint8)
    for index, payload in enumerate(encoded):
        with Image.open(io.BytesIO(bytes(payload))) as handle:
            image = handle.convert("RGB")
            if image.size != (size, size):
                image = image.resize((size, size), Image.BILINEAR)
            out[index] = np.array(image, dtype=np.uint8)
    return out


@torch.no_grad()
def embed(
    model: torch.nn.Module,
    images: np.ndarray,
    device: torch.device,
    batch_size: int = BATCH_SIZE,
    flip: bool = False,
    amp: bool = True,
) -> np.ndarray:
    """Embed every image, optionally adding its mirror, and normalise each row."""
    from .data import normalize_batch

    model.eval()
    out: np.ndarray | None = None
    for start in range(0, len(images), batch_size):
        chunk = images[start : start + batch_size]
        tensor = torch.from_numpy(chunk).permute(0, 3, 1, 2).to(device)
        half = amp and device.type == "cuda"
        with torch.autocast(device.type, dtype=torch.float16, enabled=half):
            vectors = model(normalize_batch(tensor))
            if flip:
                vectors = vectors + model(normalize_batch(torch.flip(tensor, dims=[3])))
        if out is None:
            out = np.zeros((len(images), vectors.shape[1]), dtype=np.float32)
        out[start : start + len(chunk)] = vectors.float().cpu().numpy()
    norms = np.linalg.norm(out, axis=1, keepdims=True)
    return out / np.maximum(norms, 1e-10)


def pair_scores(embeddings: np.ndarray) -> np.ndarray:
    """Cosine similarity of each consecutive pair of rows."""
    left, right = embeddings[0::2], embeddings[1::2]
    return (left * right).sum(axis=1)


def accuracy_at(scores: np.ndarray, issame: np.ndarray, threshold: float) -> float:
    predicted = scores >= threshold
    return float((predicted == issame).mean())


def kfold_accuracy(
    scores: np.ndarray, issame: np.ndarray, folds: int = FOLDS, steps: int = THRESHOLD_STEPS
) -> dict[str, float]:
    """Accuracy of a threshold picked on the other folds, averaged over folds."""
    thresholds = np.linspace(-1.0, 1.0, steps)
    correct = (scores[None, :] >= thresholds[:, None]) == issame[None, :]

    edges = np.linspace(0, len(scores), folds + 1).astype(int)
    accuracies, chosen = [], []
    for fold in range(folds):
        test = np.zeros(len(scores), dtype=bool)
        test[edges[fold] : edges[fold + 1]] = True
        if not test.any() or test.all():
            continue
        best = int(correct[:, ~test].mean(axis=1).argmax())
        accuracies.append(float(correct[best, test].mean()))
        chosen.append(float(thresholds[best]))
    return {
        "accuracy": float(np.mean(accuracies)),
        "accuracy_std": float(np.std(accuracies)),
        "threshold": float(np.mean(chosen)),
    }


def tar_at_far(scores: np.ndarray, issame: np.ndarray, far_target: float) -> float:
    """True accept rate at the strictest threshold whose false accepts stay under target.

    Returns 0 when no threshold is strict enough, which is the honest reading:
    the model cannot operate at that false-accept rate at all.
    """
    negatives = np.sort(scores[~issame])[::-1]
    if not len(negatives) or not issame.any():
        return 0.0
    allowed = int(np.floor(far_target * len(negatives)))
    if allowed >= len(negatives):
        return 1.0
    threshold = float(negatives[allowed]) + np.finfo(np.float32).eps
    return float((scores[issame] >= threshold).mean())


def evaluate_pairs(scores: np.ndarray, issame: np.ndarray) -> dict[str, float]:
    """Every number one benchmark yields, from its pair scores."""
    result = kfold_accuracy(scores, issame)
    for target in FAR_TARGETS:
        result[f"tar@far{target:g}"] = tar_at_far(scores, issame, target)
    return result


def evaluate_benchmark(
    model: torch.nn.Module,
    path: Path,
    device: torch.device,
    batch_size: int = BATCH_SIZE,
    flip: bool = False,
    size: int = ALIGNED_SIZE,
) -> dict[str, float]:
    """Load one .bin, embed it at the model's own input side and score it."""
    encoded, issame = read_bin(path)
    images = decode_images(encoded, size)
    embeddings = embed(model, images, device, batch_size, flip)
    return evaluate_pairs(pair_scores(embeddings), issame)


def evaluate_all(
    model: torch.nn.Module,
    root: Path,
    device: torch.device,
    names: tuple[str, ...] = BENCHMARKS,
    batch_size: int = BATCH_SIZE,
    flip: bool = False,
    size: int = ALIGNED_SIZE,
) -> dict[str, dict[str, float]]:
    """Score every benchmark present under root, skipping the ones that are not."""
    results: dict[str, dict[str, float]] = {}
    for name in names:
        path = Path(root) / f"{name}.bin"
        if path.is_file():
            results[name] = evaluate_benchmark(model, path, device, batch_size, flip, size)
    return results


def load_run(run: Path) -> tuple[object, torch.nn.Module]:
    """Rebuild a run's model from the config it froze."""
    from facepipe.core.config import load_run_config
    from facepipe.core.registry import MODELS

    from .model import mobilefacenet  # noqa: F401  registers "mobilefacenet"

    cfg = load_run_config(run)
    model = MODELS.build({"name": cfg.model.name, "params": cfg.model.params})
    payload = torch.load(run / "ckpt" / "best.pth", map_location="cpu", weights_only=False)
    model.load_state_dict(payload["ema"]["module"] if "ema" in payload else payload["model"])
    return cfg, model


def export_spec(run: Path, model: torch.nn.Module | None = None):
    """The module to trace, one example input, and the names of both ends.

    model overrides the run's own weights, which is how the quantisation
    passes export the graph they just rewrote.
    """
    from facepipe.core.config import load_run_config

    cfg = load_run_config(run)
    traced = model if model is not None else load_run(run)[1]
    traced.eval()
    height, width = cfg.model.input_hw
    return cfg, traced, (torch.zeros(1, 3, height, width),), ["face"], ["embedding"]



def main(argv: list[str] | None = None) -> int:
    from facepipe.core.registry import MODELS

    from .model import mobilefacenet  # noqa: F401  registers "mobilefacenet"

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ckpt", type=Path, default=None)
    parser.add_argument("--run", type=Path, default=None,
                        help="score this run's best.pth with its frozen config instead of --ckpt")
    parser.add_argument("--benchmarks", type=Path, default=Path("data/raw/recognition/benchmarks"))
    parser.add_argument("--model", default="mobilefacenet")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--flip", action="store_true")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = parser.parse_args(argv)

    if (args.ckpt is None) == (args.run is None):
        parser.error("give exactly one of --ckpt or --run")

    device = torch.device(args.device)
    if args.run is not None:
        cfg, model = load_run(args.run)
        size = int(cfg.model.input_hw[0])
    else:
        model = MODELS.build({"name": args.model, "params": {}})
        payload = torch.load(args.ckpt, map_location="cpu", weights_only=False)
        model.load_state_dict(payload.get("model", payload))
        size = ALIGNED_SIZE
    model = model.to(device)

    results = evaluate_all(model, args.benchmarks, device, flip=args.flip, size=size)
    for name, scores in results.items():
        line = " ".join(f"{key}={value:.4f}" for key, value in scores.items())
        print(f"{name:10s} {line}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
