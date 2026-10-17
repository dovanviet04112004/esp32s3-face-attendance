"""Freeze a trained run into ONNX, the first link of the export chain.

The graph it writes is the Q0 rung of KEHOACH 3.7: still float, and the
reference every quantised rung below is measured against. What shape the
graph has belongs to the branch, so the branch hands it over in export_spec.
"""

import argparse
from pathlib import Path

import numpy as np
import torch

from facepipe.tasks import module_of

OPSET = 13


def flat_tensors(args: tuple) -> list[torch.Tensor]:
    """The example inputs in the order ONNX will list them."""
    out: list[torch.Tensor] = []
    for arg in args:
        out.extend(arg) if isinstance(arg, (tuple, list)) else out.append(arg)
    return out


def agreement(
    model: torch.nn.Module, onnx_path: Path, args: tuple, relative: bool = False
) -> float:
    """Largest gap between the torch graph and the written one over every output.

    relative measures each output's gap against the largest magnitude torch gives it.
    """
    import onnxruntime

    with torch.no_grad():
        expected = model(*args)
    expected = expected if isinstance(expected, (tuple, list)) else (expected,)
    session = onnxruntime.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    tensors = flat_tensors(args)
    feeds = {inp.name: tensors[i].numpy() for i, inp in enumerate(session.get_inputs())}
    got = session.run(None, feeds)
    tiny = np.finfo(np.float32).tiny
    gaps = []
    for a, b in zip(expected, got, strict=True):
        gap = float(np.abs(a.numpy() - b).max())
        gaps.append(gap / max(float(np.abs(a.numpy()).max()), tiny) if relative else gap)
    return max(gaps)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True, help="a run directory under artifacts")
    parser.add_argument("--out", type=Path, required=True, help="where the .onnx file goes")
    parser.add_argument(
        "--runtime",
        choices=("tflite", "espdl"),
        default="tflite",
        help="the runtime the graph is traced for; this graph feeds onnx2tf by default",
    )
    args = parser.parse_args(argv)

    _cfg, model, example, input_names, output_names = module_of(args.run, "eval").export_spec(
        args.run, runtime=args.runtime
    )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        example,
        str(args.out),
        opset_version=OPSET,
        input_names=input_names,
        output_names=output_names,
        dynamo=False,
    )

    gap = agreement(model, args.out, example)
    size_kb = args.out.stat().st_size / 1024.0
    print(f"{args.out.name}  {size_kb:.1f} KB  max|torch-onnx| {gap:.3e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
