"""Turn published MiniFASNet weights into a run this branch can carry (KEHOACH 3).

Preprocessing differences are folded into the weights so no runtime code learns
about them: the first convolution takes RGB in [0, 1] and the output rows read
live first. Parity against the source's ONNX is checked before a file is written.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch

from facepipe.core.config import load_config
from facepipe.core.registry import MODELS
from facepipe.core.run_dir import create_run_dir
from facepipe.core.seed import seed_everything
from facepipe.core.trainer import CKPT_BEST, CKPT_LAST, imported_checkpoint

from .model import minifasnet_v2  # noqa: F401  registers "minifasnet_v2"

PIXEL_LEVELS = 255.0
BN_EPS = 1e-5
# minivision columns are [print, live, replay]; the loss and the board want live first.
CLASS_ORDER = (1, 2, 0)
PARITY_TOLERANCE = 1e-4
PARITY_SAMPLES = 8
# minivision reads BGR in [0, 255] and three classes; facenox reads RGB in [0, 1], live first.
SOURCES = ("minivision", "facenox")


def upstream_state(path: Path, source: str) -> dict[str, torch.Tensor]:
    """The source's state dict with its wrapper prefixes and field names ours."""
    raw = torch.load(path, map_location="cpu", weights_only=False)
    if source == "facenox":
        # MultiFTNet keeps the classifier under `model.` beside a training-only Fourier head.
        raw = {k.removeprefix("model.").replace("logits.", "prob."): v
               for k, v in raw["model_state_dict"].items() if k.startswith("model.")}
    else:
        raw = raw.get("state_dict", raw) if isinstance(raw, dict) else raw
    return {k.removeprefix("module.").replace(".prelu.", ".act."): v for k, v in raw.items()}


def folded(state: dict[str, torch.Tensor], activation: str, stem: str,
           source: str = "minivision", prob_bias: bool = False) -> dict[str, torch.Tensor]:
    """Fold channel order, pixel range, class order and the split stem into the weights."""
    out = dict(state)
    if source == "minivision":
        first = out["conv1.conv.weight"]
        # BGR to RGB along the input axis, and [0,255] to [0,1] at the same place.
        out["conv1.conv.weight"] = first.flip(1).contiguous() * PIXEL_LEVELS
        out["prob.weight"] = out["prob.weight"][list(CLASS_ORDER)].contiguous()
    if prob_bias:
        out["prob.bias"] = torch.zeros(out["prob.weight"].shape[0])
    if stem == "split_prelu":
        out = split_stem(out)
    if activation == "relu":
        out = {k: v for k, v in out.items() if not k.endswith(".act.weight")}
    return out


def split_stem(state: dict[str, torch.Tensor]) -> dict[str, torch.Tensor]:
    """conv1 and conv2_dw as SplitPReLUStem weights; the algebra is in KEHOACH 3."""
    out = {k: v for k, v in state.items()
           if not (k.startswith("conv1.") or k.startswith("conv2_dw."))}
    slope = state["conv1.act.weight"]
    for k, v in state.items():
        if k.startswith("conv1.") and not k.endswith(".act.weight"):
            out["stem.conv_pos." + k[len("conv1."):]] = v
        if k.startswith("conv2_dw.") and not k.endswith(".act.weight"):
            out["stem.dw_pos." + k[len("conv2_dw."):]] = v
    # ReLU(-BN1(Wx)): negate the kernel, and turn BN1 into -BN1 of its own input.
    out["stem.conv_neg.conv.weight"] = -state["conv1.conv.weight"]
    out["stem.conv_neg.bn.weight"] = state["conv1.bn.weight"]
    out["stem.conv_neg.bn.bias"] = -state["conv1.bn.bias"]
    out["stem.conv_neg.bn.running_mean"] = -state["conv1.bn.running_mean"]
    out["stem.conv_neg.bn.running_var"] = state["conv1.bn.running_var"]
    out["stem.conv_neg.bn.num_batches_tracked"] = state["conv1.bn.num_batches_tracked"]
    bn_scale = state["conv2_dw.bn.weight"] / torch.sqrt(state["conv2_dw.bn.running_var"] + BN_EPS)
    out["stem.dw_neg.weight"] = -(slope * bn_scale).view(-1, 1, 1, 1) * state["conv2_dw.conv.weight"]
    return out


def parity(model: torch.nn.Module, onnx_path: Path, size: int, source: str) -> float:
    """Largest gap between this module on RGB [0,1] and the source graph on its own input."""
    import onnxruntime as ort

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    name = session.get_inputs()[0].name
    rng = np.random.default_rng(0)
    worst = 0.0
    model.eval()
    with torch.no_grad():
        for _ in range(PARITY_SAMPLES):
            pixels = rng.integers(0, 256, (1, 3, size, size)).astype(np.float32)
            if source == "minivision":
                theirs = session.run(None, {name: pixels[:, ::-1].copy()})[0][0][list(CLASS_ORDER)]
            else:
                theirs = session.run(None, {name: pixels / PIXEL_LEVELS})[0][0]
            ours = model(torch.from_numpy(pixels / PIXEL_LEVELS)).numpy()[0]
            worst = max(worst, float(np.abs(theirs - ours).max()))
    return worst


def stem_parity(model: torch.nn.Module, state: dict[str, torch.Tensor], params: dict, size: int,
                source: str) -> float:
    """Largest gap between the split stem and PReLU kept at conv1, ReLU elsewhere."""
    reference = MODELS.build({"name": "minifasnet_v2", "params": {**params, "stem": "plain"}})
    reference.load_state_dict(folded(state, str(params.get("activation", "relu")), "plain", source,
                                     bool(params.get("prob_bias", False))), strict=True)
    reference.conv1.act = torch.nn.PReLU(state["conv1.act.weight"].numel())
    reference.conv1.act.weight.data.copy_(state["conv1.act.weight"])
    reference.eval()
    model.eval()
    rng = np.random.default_rng(1)
    worst = 0.0
    with torch.no_grad():
        for _ in range(PARITY_SAMPLES):
            pixels = torch.from_numpy(rng.random((1, 3, size, size), dtype=np.float32))
            worst = max(worst, float((reference(pixels) - model(pixels)).abs().max()))
    return worst


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, required=True, help="upstream .pth")
    parser.add_argument("--cfg", type=Path, required=True)
    parser.add_argument("--onnx", type=Path, default=None,
                        help="source ONNX to check parity against; only valid for prelu")
    parser.add_argument("--source", choices=SOURCES, default="minivision")
    parser.add_argument("--set", nargs="*", default=[], metavar="KEY=VALUE")
    args = parser.parse_args(argv)

    cfg = load_config(args.cfg, args.set)
    seed_everything(cfg.run.seed, deterministic=cfg.run.deterministic)
    activation = str(cfg.model.params.get("activation", "relu"))
    stem = str(cfg.model.params.get("stem", "plain"))
    size = int(cfg.model.input_hw[0])

    state = upstream_state(args.weights, args.source)
    model = MODELS.build({"name": cfg.model.name, "params": dict(cfg.model.params)})
    prob_bias = bool(cfg.model.params.get("prob_bias", False))
    model.load_state_dict(folded(state, activation, stem, args.source, prob_bias), strict=True)

    if stem == "split_prelu":
        gap = stem_parity(model, state, dict(cfg.model.params), size, args.source)
        if gap > PARITY_TOLERANCE:
            raise SystemExit(f"stem parity gap {gap:.3e} exceeds {PARITY_TOLERANCE:.0e}; nothing written")
        print(f"split stem vs PReLU at conv1: max|diff| {gap:.3e}")
    if args.onnx is not None:
        if activation != "prelu" or stem != "plain":
            raise SystemExit("parity against the source graph holds only for the plain PReLU model")
        gap = parity(model, args.onnx, size, args.source)
        if gap > PARITY_TOLERANCE:
            raise SystemExit(f"parity gap {gap:.3e} exceeds {PARITY_TOLERANCE:.0e}; nothing written")
        print(f"parity vs {args.onnx.name}: max|diff| {gap:.3e}")

    run = create_run_dir(cfg)
    payload = imported_checkpoint(model, cfg, run.run_id)
    torch.save(payload, run.path / "ckpt" / CKPT_LAST)
    torch.save(payload, run.path / "ckpt" / CKPT_BEST)
    print(f"{run.run_id}  activation={activation}  {run.path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
