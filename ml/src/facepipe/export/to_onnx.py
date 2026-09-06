"""Freeze a trained run into ONNX, the first link of the export chain.

The graph it writes is the Q0 rung of KEHOACH 3.8: still float, and the
reference every quantised rung below is measured against.
"""

import argparse
import importlib
from pathlib import Path

import numpy as np
import torch

# The registry only knows a model once its module has been imported, and which
# module that is belongs to the branch, not to this file.
BRANCH_LOADERS = {
    "minifasnet_v2_se": "facepipe.tasks.antispoof.eval",
    "cdcnpp": "facepipe.tasks.antispoof.eval",
}

OPSET = 13


def two_view_inputs(height: int, width: int) -> tuple[torch.Tensor, torch.Tensor]:
    """The pair of crops the anti-spoof student reads, as one example batch."""
    return torch.zeros(1, 3, height, width), torch.zeros(1, 3, height, width)


def agreement(model: torch.nn.Module, onnx_path: Path, views: tuple) -> float:
    """Largest absolute gap between the torch graph and the written one."""
    import onnxruntime

    with torch.no_grad():
        expected = model(views).numpy()
    session = onnxruntime.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    feeds = {inp.name: views[i].numpy() for i, inp in enumerate(session.get_inputs())}
    got = session.run(None, feeds)[0]
    return float(np.abs(expected - got).max())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True, help="a run directory under artifacts")
    parser.add_argument("--out", type=Path, required=True, help="where the .onnx file goes")
    args = parser.parse_args(argv)

    from facepipe.core.config import load_config

    cfg = load_config(args.run / "config.resolved.yaml", [])
    loader = BRANCH_LOADERS.get(cfg.model.name)
    if loader is None:
        raise SystemExit(f"no loader known for model {cfg.model.name}")
    _, model = importlib.import_module(loader).load_run(args.run)
    model.eval()

    height, width = cfg.model.input_hw
    views = two_view_inputs(height, width)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        (views,),
        str(args.out),
        opset_version=OPSET,
        input_names=["tight", "wide"],
        output_names=["logits"],
        dynamo=False,
    )

    gap = agreement(model, args.out, views)
    size_kb = args.out.stat().st_size / 1024.0
    print(f"{args.out.name}  {size_kb:.1f} KB  max|torch-onnx| {gap:.3e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
