"""The anti-spoof branch's hooks of the ESP-DL ladder (KEHOACH 3.7): calibration, probe, ruler.

Every input the graph has arrives in the same sample: calibrating one while
another holds zeros measures a range the model never meets. The ruler is the
board's own frames, cut the way preproc.cpp cuts them.
"""

from __future__ import annotations

import re

import numpy as np

PREPROC_CPP = "firmware/components/ai_engine/src/antispoof/preproc.cpp"
VISION_KCONFIG = "firmware/components/svc_vision/Kconfig"
FACE_SCALE = re.compile(r"kFaceScale\s*=\s*([0-9.]+)f?;")
LIVE_MIN = re.compile(r"config VISION_SEED_LIVE_MIN_PERMILLE.*?default\s+(\d+)", re.S)
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
    """Liveness on the board's own frames, cut the way preproc.cpp cuts them."""
    from facepipe.compress.quant.ladder import device_frames, run_batch

    from .losses.task_loss import LIVE

    x, truth = face_crops(cfg, device_frames())
    return metrics_of(live_scores(run_batch(runner, x)[0], LIVE), truth)


def metrics_of(live: np.ndarray, truth: np.ndarray) -> dict[str, float]:
    """Real faces kept and attacks blocked at the kiosk's live_min, with AUC and EER."""
    from facepipe.compress.quant.ladder import firmware_constant

    from .eval import auc, equal_error_rate
    from .losses.task_loss import LIVE

    floor = firmware_constant(VISION_KCONFIG, LIVE_MIN) / 1000.0
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
    """Attacks blocked first, APCER being the branch's must (KEHOACH 1.1), then real faces kept."""
    return (metrics["attacks_blocked"], metrics["real_kept"], metrics["auc"])


def gate(metrics: dict[str, float], ceiling: dict[str, float]) -> bool:
    """KEHOACH 3.7: every attack blocked and no fewer real faces kept than Q0."""
    return (
        metrics["attacks_blocked"] == metrics["attacks"]
        and metrics["real_kept"] >= ceiling["real_kept"]
    )


def headline(metrics: dict[str, float]) -> str:
    return (
        f"real kept {metrics['real_kept']}/{metrics['real']}  attacks blocked "
        f"{metrics['attacks_blocked']}/{metrics['attacks']}  auc {metrics['auc']:.4f}"
        f"  real min {metrics['real_min']:.3f}  attack max {metrics['attack_max']:.3f}"
    )
