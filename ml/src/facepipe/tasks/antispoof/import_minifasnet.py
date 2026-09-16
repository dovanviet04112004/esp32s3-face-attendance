"""Turn the published MiniFASNetV2 weights into a run this branch can carry (KEHOACH 3).

Three preprocessing differences are folded into the weights so no runtime code
learns about them: the first convolution takes RGB in [0, 1] and the output rows
read [live, replay, print]. Parity against the upstream ONNX is checked before a
single file is written.
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np
import torch

from facepipe.core.config import Config, load_config
from facepipe.core.registry import MODELS
from facepipe.core.run_dir import create_run_dir
from facepipe.core.scheduler import build_optimizer
from facepipe.core.seed import capture_rng_state, seed_everything
from facepipe.core.trainer import CKPT_BEST, CKPT_FORMAT_VER, CKPT_LAST, resolve_device

from .model import minifasnet_v2  # noqa: F401  registers "minifasnet_v2"

PIXEL_LEVELS = 255.0
# Upstream columns are [print, live, replay]; the loss and the board want live first.
CLASS_ORDER = (1, 2, 0)
PARITY_TOLERANCE = 1e-4
PARITY_SAMPLES = 8


def upstream_state(path: Path) -> dict[str, torch.Tensor]:
    """The upstream state dict with its DataParallel prefix and field names ours."""
    raw = torch.load(path, map_location="cpu", weights_only=False)
    raw = raw.get("state_dict", raw) if isinstance(raw, dict) else raw
    return {k.removeprefix("module.").replace(".prelu.", ".act."): v for k, v in raw.items()}


def folded(state: dict[str, torch.Tensor], activation: str) -> dict[str, torch.Tensor]:
    """Fold channel order, pixel range and class order into the weights."""
    out = dict(state)
    first = out["conv1.conv.weight"]
    # BGR to RGB along the input axis, and [0,255] to [0,1] at the same place.
    out["conv1.conv.weight"] = first.flip(1).contiguous() * PIXEL_LEVELS
    out["prob.weight"] = out["prob.weight"][list(CLASS_ORDER)].contiguous()
    if activation == "relu":
        out = {k: v for k, v in out.items() if not k.endswith(".act.weight")}
    return out


def parity(model: torch.nn.Module, onnx_path: Path, size: int) -> float:
    """Largest gap between this module on RGB [0,1] and upstream on BGR [0,255]."""
    import onnxruntime as ort

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    name = session.get_inputs()[0].name
    rng = np.random.default_rng(0)
    worst = 0.0
    model.eval()
    with torch.no_grad():
        for _ in range(PARITY_SAMPLES):
            pixels = rng.integers(0, 256, (1, 3, size, size)).astype(np.float32)
            theirs = session.run(None, {name: pixels[:, ::-1].copy()})[0][0][list(CLASS_ORDER)]
            ours = model(torch.from_numpy(pixels / PIXEL_LEVELS)).numpy()[0]
            worst = max(worst, float(np.abs(theirs - ours).max()))
    return worst


def checkpoint(model: torch.nn.Module, cfg: Config, run_id: str) -> dict:
    """The payload Trainer.save_checkpoint writes, at epoch zero with fresh optimiser state."""
    device = resolve_device(cfg.train.device)
    scaler = torch.amp.GradScaler(device.type, enabled=bool(cfg.train.amp))
    return {
        "format_ver": CKPT_FORMAT_VER,
        "epoch": 0,
        "global_step": 0,
        "best_metric": math.inf,
        "best_is_lower": True,
        "history": [],
        "model": model.state_dict(),
        "optimizer": build_optimizer(model, cfg.optim).state_dict(),
        "scaler": scaler.state_dict(),
        "rng": capture_rng_state(),
        "elsewhere": {},
        "run_id": run_id,
        "resumed_from": None,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, required=True, help="upstream .pth")
    parser.add_argument("--cfg", type=Path, required=True)
    parser.add_argument("--onnx", type=Path, default=None,
                        help="upstream ONNX to check parity against; only valid for prelu")
    parser.add_argument("--set", nargs="*", default=[], metavar="KEY=VALUE")
    args = parser.parse_args(argv)

    cfg = load_config(args.cfg, args.set)
    seed_everything(cfg.run.seed, deterministic=cfg.run.deterministic)
    activation = str(cfg.model.params.get("activation", "relu"))
    size = int(cfg.model.input_hw[0])

    model = MODELS.build({"name": cfg.model.name, "params": dict(cfg.model.params)})
    model.load_state_dict(folded(upstream_state(args.weights), activation), strict=True)

    if args.onnx is not None:
        if activation != "prelu":
            raise SystemExit("parity against the upstream graph holds only for activation=prelu")
        gap = parity(model, args.onnx, size)
        if gap > PARITY_TOLERANCE:
            raise SystemExit(f"parity gap {gap:.3e} exceeds {PARITY_TOLERANCE:.0e}; nothing written")
        print(f"parity vs {args.onnx.name}: max|diff| {gap:.3e}")

    run = create_run_dir(cfg)
    payload = checkpoint(model, cfg, run.run_id)
    torch.save(payload, run.path / "ckpt" / CKPT_LAST)
    torch.save(payload, run.path / "ckpt" / CKPT_BEST)
    print(f"{run.run_id}  activation={activation}  {run.path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
