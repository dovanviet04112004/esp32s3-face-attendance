"""Run the Q1 rung end to end: fold, equalise, correct bias, then convert.

Each step is optional so the ladder can show what each one is worth. Turning
them all off leaves plain min-max PTQ, which is the floor the rest is measured
against (KEHOACH 3.7).
"""

import argparse
import importlib
from pathlib import Path

import torch

from ...export import onnx_to_tf, tf_to_tflite_int8, to_onnx
from . import bias_correction, cle, fold_bn


def prepared(run: Path, do_fold: bool, do_cle: bool, do_bias: bool, samples: int):
    """The model with whichever pre-quantisation passes were asked for."""
    from facepipe.core.config import load_run_config

    cfg = load_run_config(run)
    package = tf_to_tflite_int8.BRANCH_PACKAGE[cfg.model.name]
    _, model = importlib.import_module(f"{package}.eval").load_run(run)
    model.eval()

    report: dict[str, object] = {}
    if do_fold:
        report["folded"] = fold_bn.fold(model)
    if do_cle:
        moved = cle.apply(model)
        report["equalised"] = len(moved)
        report["widest_scale"] = round(max(moved.values()), 3) if moved else 1.0
    if do_bias:
        quant = importlib.import_module(f"{package}.quant")
        feed = quant.torch_batches(cfg, None, samples)
        shifts = bias_correction.correct(model, feed)
        report["biased"] = len(shifts)
        report["largest_shift"] = round(max(shifts.values()), 6) if shifts else 0.0
    return cfg, model, report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True, help="the .tflite to write")
    parser.add_argument("--work", type=Path, required=True, help="scratch for onnx and SavedModel")
    parser.add_argument("--no-fold", action="store_true")
    parser.add_argument("--no-cle", action="store_true")
    parser.add_argument("--no-bias", action="store_true")
    parser.add_argument("--samples", type=int, default=300)
    args = parser.parse_args(argv)

    cfg, model, report = prepared(
        args.run, not args.no_fold, not args.no_cle, not args.no_bias, args.samples
    )
    for key, value in report.items():
        print(f"  {key}: {value}")

    args.work.mkdir(parents=True, exist_ok=True)
    onnx_path = args.work / "prepared.onnx"
    package = tf_to_tflite_int8.BRANCH_PACKAGE[cfg.model.name]
    _, traced, example, input_names, output_names = importlib.import_module(
        f"{package}.eval"
    ).export_spec(args.run, model)
    torch.onnx.export(
        traced,
        example,
        str(onnx_path),
        opset_version=to_onnx.OPSET,
        input_names=input_names,
        output_names=output_names,
        dynamo=False,
    )
    saved = onnx_to_tf.convert(onnx_path, args.work / "saved")

    def representative():
        yield from tf_to_tflite_int8.calibration_samples(args.run, None, args.samples)

    size = tf_to_tflite_int8.convert(saved, args.out, representative)
    print(f"Q1  {args.out.name}  {size / 1024.0:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
