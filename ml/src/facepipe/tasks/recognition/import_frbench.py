"""Turn FRBench's published MobileFaceNet-ECA weights into a run this branch carries (KEHOACH 3).

The port keeps upstream's parameter names, so the state dict loads strictly with
no renaming and no weight is rewritten. Parity against a graph exported from
FRBench's own code is checked before a file is written.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch

from facepipe.core.config import load_config
from facepipe.core.registry import MODELS
from facepipe.core.run_dir import create_run_dir, sha256_file
from facepipe.core.seed import seed_everything
from facepipe.core.trainer import CKPT_BEST, CKPT_LAST, imported_checkpoint

from .model import mobilefacenet_eca  # noqa: F401  registers "mobilefacenet_eca"

PARITY_TOLERANCE = 1e-4
PARITY_SAMPLES = 8


def upstream_state(path: Path) -> dict[str, torch.Tensor]:
    """The published state dict, with a DataParallel prefix dropped if one is there."""
    raw = torch.load(path, map_location="cpu", weights_only=False)
    raw = raw.get("state_dict", raw) if isinstance(raw, dict) else raw
    return {k.removeprefix("module."): v for k, v in raw.items()}


def parity(model: torch.nn.Module, onnx_path: Path, size: int) -> float:
    """Largest gap between this module and the upstream graph on the same normalised faces."""
    import onnxruntime as ort

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    name = session.get_inputs()[0].name
    rng = np.random.default_rng(0)
    worst = 0.0
    model.eval()
    with torch.no_grad():
        for _ in range(PARITY_SAMPLES):
            faces = rng.uniform(-1.0, 1.0, (1, 3, size, size)).astype(np.float32)
            theirs = session.run(None, {name: faces})[0]
            ours = model(torch.from_numpy(faces)).numpy()
            worst = max(worst, float(np.abs(theirs - ours).max()))
    return worst


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, required=True,
                        help="mobilefacenet_arcface_ms1m.pth")
    parser.add_argument("--cfg", type=Path, required=True)
    parser.add_argument("--onnx", type=Path, default=None,
                        help="graph exported from FRBench's own code, to check parity against")
    parser.add_argument("--set", nargs="*", default=[], metavar="KEY=VALUE")
    args = parser.parse_args(argv)

    cfg = load_config(args.cfg, args.set)
    seed_everything(cfg.run.seed, deterministic=cfg.run.deterministic)
    size = int(cfg.model.input_hw[0])
    digest = sha256_file(args.weights)
    if digest[:16] not in cfg.run.notes:
        raise SystemExit(f"{args.weights.name} is sha256 {digest[:16]}, which run.notes does not "
                         "name; the run would record the wrong source")

    model = MODELS.build({"name": cfg.model.name, "params": dict(cfg.model.params)})
    model.load_state_dict(upstream_state(args.weights), strict=True)
    if args.onnx is not None:
        gap = parity(model, args.onnx, size)
        if gap > PARITY_TOLERANCE:
            raise SystemExit(f"parity gap {gap:.3e} exceeds {PARITY_TOLERANCE:.0e}; "
                             "nothing written")
        print(f"parity vs {args.onnx.name}: max|diff| {gap:.3e}")

    run = create_run_dir(cfg)
    payload = imported_checkpoint(model, cfg, run.run_id)
    torch.save(payload, run.path / "ckpt" / CKPT_LAST)
    torch.save(payload, run.path / "ckpt" / CKPT_BEST)
    print(f"{run.run_id}  sha256 {digest}  {run.path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
