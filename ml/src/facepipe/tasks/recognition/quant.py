"""The recognition branch's hooks of the ESP-DL ladder (KEHOACH 3.7): calibration, probe, ruler.

Faces reach the graph already normalised, so the calibration path applies the
same normalisation training applies. Feeding raw bytes here would set every
activation range against a scale the model never sees.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch

FACES: dict[tuple, np.ndarray] = {}


# One step of the main ruler, 0.1 point of TAR (KEHOACH 3.7 selection rule).
RESOLUTION = 0.001


def calibration_batches(cfg: object, split: str | None, limit: int):
    """Yield real aligned faces one at a time, keyed by the graph's input name."""
    from .data import Ms1mShardDataset, collate, normalize_batch, read_identities

    dataset = Ms1mShardDataset(
        root=Path(cfg.data.params["shards"]),
        identities=read_identities(Path(split or cfg.data.split_files[1])),
        size=int(cfg.model.input_hw[0]),
        train=False,
        seed=cfg.run.seed,
    )
    loader = torch.utils.data.DataLoader(dataset, batch_size=1, collate_fn=collate)
    for taken, (images, _targets) in enumerate(loader):
        if taken >= limit:
            return
        faces = normalize_batch(images).numpy().transpose(0, 2, 3, 1)
        yield {"face": np.ascontiguousarray(faces, dtype=np.float32)}


def torch_batches(cfg: object, split: str | None, samples: int):
    """One batch shaped the way the model's own forward reads it."""
    from .data import Ms1mShardDataset, collate, normalize_batch, read_identities

    dataset = Ms1mShardDataset(
        root=Path(cfg.data.params["shards"]),
        identities=read_identities(Path(split or cfg.data.split_files[1])),
        size=int(cfg.model.input_hw[0]),
        train=False,
        seed=cfg.run.seed,
    )
    loader = torch.utils.data.DataLoader(dataset, batch_size=samples, collate_fn=collate)
    for images, _targets in loader:
        yield normalize_batch(images)
        return


def aligned_faces(cfg: object, frames) -> np.ndarray:
    """Each found face aligned as align.cpp warps it and normalised as training does, float NCHW."""
    from facepipe.compress.quant.ladder import data_path
    from facepipe.tasks.antispoof.eval import largest_detection, load_detector

    from .postproc.align import align

    size = int(cfg.model.input_hw[0])
    detector, priors = load_detector(data_path("antispoof.detector"), torch.device("cpu"))
    faces = []
    for _name, _label, rgb in frames:
        found = largest_detection(detector, priors, rgb, torch.device("cpu"))
        if found is not None:
            faces.append(align(rgb, found[1], size))
    return ((np.stack(faces).astype(np.float32) - 127.5) / 127.5).transpose(0, 3, 1, 2)


def probe_inputs(cfg: object, frames, count: int) -> np.ndarray:
    """The first count faces of test_device aligned as the firmware aligns them, float NCHW."""
    key = (int(cfg.model.input_hw[0]), tuple(name for name, _label, _rgb in frames))
    if key not in FACES:
        FACES[key] = aligned_faces(cfg, frames)
    return FACES[key][:count]


def score(runner, cfg: object) -> dict[str, float]:
    """Accuracy and TAR at FAR 1e-3 and 1e-4 on each verification benchmark, from the runner."""
    from facepipe import ML_ROOT
    from facepipe.compress.quant.ladder import run_batch

    from .eval import BENCHMARKS, decode_images, evaluate_pairs, pair_scores, read_bin

    root = ML_ROOT / cfg.data.params["benchmarks"]
    size = int(cfg.model.input_hw[0])
    found = {}
    for name in BENCHMARKS:
        if not (root / f"{name}.bin").is_file():
            continue
        encoded, issame = read_bin(root / f"{name}.bin")
        images = decode_images(encoded, size)
        x = ((images.astype(np.float32) - 127.5) / 127.5).transpose(0, 3, 1, 2)
        vectors = run_batch(runner, x, chunk=32)[0].reshape(len(x), -1)
        vectors /= np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-10)
        result = evaluate_pairs(pair_scores(vectors), issame)
        key = name.replace("-", "_").lower()
        found[f"{key}_acc"] = float(result["accuracy"])
        found[f"{key}_tar3"] = float(result["tar@far0.001"])
        found[f"{key}_tar4"] = float(result["tar@far0.0001"])
    return found


def rank(metrics: dict[str, float]) -> tuple:
    """The branch's ruler: TAR at FAR 1e-3 on CFP-FP, the checkpoint measure (KEHOACH 3.7)."""
    return (metrics["cfp_fp_tar3"],)


def gate(metrics: dict[str, float], ceiling: dict[str, float]) -> bool:
    """KEHOACH 3.7: TAR at FAR 1e-3 on CFP-FP within 1% of Q0."""
    return metrics["cfp_fp_tar3"] >= 0.99 * ceiling["cfp_fp_tar3"]


def headline(metrics: dict[str, float]) -> str:
    names = sorted({key.rsplit("_", 1)[0] for key in metrics})
    return "  ".join(
        f"{n} {metrics[n + '_acc']:.4f} / {metrics[n + '_tar3']:.3f} / {metrics[n + '_tar4']:.3f}"
        for n in names
    )
