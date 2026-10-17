"""The anti-spoof branch's hooks of the ESP-DL ladder (KEHOACH 3.7): calibration, probe, ruler.

Every input the graph has arrives in the same sample: calibrating one while
another holds zeros measures a range the model never meets. The ruler is AUC on
CelebA-Spoof's held-out shards beside the board's own frames, cut as preproc.cpp
cuts them; the cross-domain sets are scored at the kiosk's threshold for reading.
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np

# Bumped whenever score() measures something new, so rows scored the old way are scored again.
RULER = "celeba-auc"
# One step of the main ruler, AUC over 39,072 faces (KEHOACH 3.7 selection rule).
RESOLUTION = 0.001
XDOMAIN_SHARDS = "antispoof.xdomain_shards"
PREPROC_CPP = "firmware/components/ai_engine/src/antispoof/preproc.cpp"
FACE_SCALE = re.compile(r"kFaceScale\s*=\s*([0-9.]+)f?;")
CROPS: dict[tuple, tuple[np.ndarray, np.ndarray]] = {}


def calibration_batches(cfg: object, split: str | None, limit: int):
    """Yield real crops one sample at a time, keyed by the graph's input names."""
    from .eval import build_loader, input_names

    names = input_names(cfg)
    loader = build_loader(cfg, split or cfg.data.params["val_split"])
    taken = 0
    for tight, wide, *_rest in loader:
        views = {"tight": tight, "wide": wide}
        for i in range(tight.shape[0]):
            if taken >= limit:
                return
            yield {
                name: np.ascontiguousarray(
                    views[name][i : i + 1].numpy().transpose(0, 2, 3, 1), dtype=np.float32
                )
                for name in names
            }
            taken += 1


def torch_batches(cfg: object, split: str | None, samples: int):
    """One batch shaped the way the model's own forward reads it."""
    from .eval import build_loader, input_names

    split = split or cfg.data.params["val_split"]
    names = input_names(cfg)
    for tight, wide, *_rest in build_loader(cfg, split):
        if len(names) > 1:
            yield (tight[:samples], wide[:samples])
        else:
            yield (wide if names == ["wide"] else tight)[:samples]
        return


def face_crops(cfg: object, frames) -> tuple[np.ndarray, np.ndarray]:
    """Every frame with a face, cut the way preproc.cpp cuts it, float NCHW, with its label."""
    key = (int(cfg.model.input_hw[0]), tuple(name for name, _label, _rgb in frames))
    if key not in CROPS:
        CROPS[key] = cut_faces(key[0], frames)
    return CROPS[key]


def cut_faces(size: int, frames) -> tuple[np.ndarray, np.ndarray]:
    import torch

    from facepipe.compress.quant.ladder import data_path, firmware_constant

    from .eval import largest_face, load_detector
    from .postproc.preproc import fitted_square, resample_square

    face_scale = firmware_constant(PREPROC_CPP, FACE_SCALE)
    detector, priors = load_detector(data_path("antispoof.detector"), torch.device("cpu"))
    crops, labels = [], []
    for _name, label, rgb in frames:
        box = largest_face(detector, priors, rgb, torch.device("cpu"))
        if box is None:
            continue
        left, top, side = fitted_square(box, face_scale, rgb.shape[1], rgb.shape[0])
        crops.append(resample_square(rgb, left, top, side, size))
        labels.append(label)
    return (np.stack(crops).astype(np.float32) / 255.0).transpose(0, 3, 1, 2), np.array(labels)


def probe_inputs(cfg: object, frames, count: int) -> np.ndarray:
    """The first count faces of test_device cut as the firmware cuts them, float NCHW."""
    return face_crops(cfg, frames)[0][:count]


def live_scores(logits: np.ndarray, live_index: int) -> np.ndarray:
    z = logits - logits.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e[:, live_index] / e.sum(axis=1)


def score(runner, cfg: object) -> dict[str, float]:
    """The board's frames, CelebA-Spoof's held-out shards and the cross-domain sets, one dict."""
    from facepipe.compress.quant.ladder import data_paths, device_frames, run_batch

    from .losses.task_loss import LIVE

    x, truth = face_crops(cfg, device_frames())
    metrics = metrics_of(live_scores(run_batch(runner, x)[0], LIVE), truth)
    celeba = shard_scores(runner, cfg, cfg.data.params["test_split"])
    metrics.update({f"celeba_{key}": value for key, value in rates_at_floor(*celeba).items()})
    for name, root in data_paths(XDOMAIN_SHARDS).items():
        other = shard_scores(runner, cfg, shard_specs(root), root)
        metrics.update({f"{name}_{key}": value for key, value in rates_at_floor(*other).items()})
    return metrics


def shard_specs(root: Path) -> list[str]:
    """The splits that cover every shard under root: root itself, or each folder that holds some."""
    if any(root.glob("shard_*.tar")):
        return ["."]
    found = sorted(p.name for p in root.iterdir() if p.is_dir() and any(p.glob("shard_*.tar")))
    if not found:
        raise FileNotFoundError(f"{root}: no shard_*.tar in it or one level down")
    return found


def shard_scores(
    runner, cfg: object, split: str | list[str], root: Path | None = None
) -> tuple[np.ndarray, np.ndarray]:
    """Live scores of runner over shard splits, read as training reads them, beside their labels."""
    from facepipe.compress.quant.ladder import run_batch

    from .eval import build_loader, input_names
    from .losses.task_loss import LIVE

    view = "wide" if input_names(cfg) == ["wide"] else "tight"
    scores, labels = [], []
    for tight, wide, label, *_rest in build_loader(cfg, split, root):
        x = (wide if view == "wide" else tight).numpy()
        scores.append(live_scores(run_batch(runner, x)[0], LIVE))
        labels.append(label.numpy())
    return np.concatenate(scores), np.concatenate(labels)


def live_floor() -> float:
    """The kiosk's live_min as a probability, the one the models image carries."""
    from facepipe.compress.quant.ptq_espdl import threshold_permille

    return threshold_permille("antispoof") / 1000.0


def rates_at_floor(live: np.ndarray, truth: np.ndarray) -> dict[str, float]:
    """APCER and BPCER at the kiosk's threshold, and AUC when both classes are present."""
    from .eval import auc
    from .losses.task_loss import LIVE

    floor = live_floor()
    real, fake = live[truth == LIVE], live[truth != LIVE]
    rates: dict[str, float] = {"n": int(live.size)}
    if fake.size:
        rates["apcer"] = float((fake >= floor).mean())
    if real.size:
        rates["bpcer"] = float((real < floor).mean())
    if real.size and fake.size:
        rates["auc"] = float(auc(live, truth))
    return rates


def metrics_of(live: np.ndarray, truth: np.ndarray) -> dict[str, float]:
    """Real faces kept and attacks blocked at the kiosk's live_min, with AUC and EER."""
    from .eval import auc, equal_error_rate
    from .losses.task_loss import LIVE

    floor = live_floor()
    real, fake = live[truth == LIVE], live[truth != LIVE]
    return {
        "real_kept": int((real >= floor).sum()),
        "real": int(real.size),
        "attacks_blocked": int((fake < floor).sum()),
        "attacks": int(fake.size),
        "auc": float(auc(live, truth)),
        "eer": float(equal_error_rate(live, truth).acer),
        "real_min": float(real.min()),
        "attack_max": float(fake.max()),
    }


def rank(metrics: dict[str, float]) -> tuple:
    """The main ruler first, AUC on CelebA-Spoof's held-out shards, then the board's frames."""
    return (metrics["celeba_auc"], metrics["attacks_blocked"], metrics["real_kept"])


def gate(metrics: dict[str, float], ceiling: dict[str, float]) -> bool:
    """KEHOACH 3.7: AUC within 1% of Q0, every board attack blocked, no fewer real faces kept."""
    return (
        metrics["celeba_auc"] >= 0.99 * ceiling["celeba_auc"]
        and metrics["attacks_blocked"] == metrics["attacks"]
        and metrics["real_kept"] >= ceiling["real_kept"]
    )


def headline(metrics: dict[str, float]) -> str:
    return (
        f"celeba auc {metrics['celeba_auc']:.4f} apcer {metrics['celeba_apcer']:.4f} bpcer "
        f"{metrics['celeba_bpcer']:.4f}  board: real kept {metrics['real_kept']}/{metrics['real']}"
        f" attacks blocked {metrics['attacks_blocked']}/{metrics['attacks']}"
    )
