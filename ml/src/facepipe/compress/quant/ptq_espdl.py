"""The Q1 rung for ESP-DL: ESP-PPQ quantises a run's graph under the S3 rules and writes .espdl.

Per-tensor power-of-two scales are the runtime's rule, so layerwise equalisation
is on for every branch and activation ranges come from KL on the same 300
samples the TFLite rung calibrates on (KEHOACH 3.7). The file carries one test
input and output, which model->test() on the board must match within one int8 step.
"""

from __future__ import annotations

import argparse
import copy
import importlib
from pathlib import Path

import numpy as np
import torch

from ...export import tf_to_tflite_int8, to_onnx
from . import fold_bn

TARGET = "esp32s3"
BITS = 8
EQUALIZATION_ITERATIONS = 4
EQUALIZATION_THRESHOLD = 0.4
EQUALIZATION_OPT_LEVEL = 2


def export_onnx(run: Path, out: Path) -> Path:
    """The run's float graph with Linear + BatchNorm1d folded away, which ESP-PPQ cannot parse."""
    from facepipe.core.config import load_run_config

    cfg = load_run_config(run)
    package = tf_to_tflite_int8.BRANCH_PACKAGE[cfg.model.name]
    evaluator = importlib.import_module(f"{package}.eval")
    model = copy.deepcopy(evaluator.load_run(run)[1]).eval()
    fold_bn.fold_linear(model)
    _, traced, example, input_names, output_names = evaluator.export_spec(run, model)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(traced, example, str(out), opset_version=to_onnx.OPSET,
                      input_names=input_names, output_names=output_names, dynamo=False)
    gap = to_onnx.agreement(traced, out, example)
    print(f"  onnx {out.name}  max|torch-onnx| {gap:.3e}")
    return out


def calibration(run: Path, samples: int) -> list[torch.Tensor]:
    """The branch's calibration set as NCHW batches of one, the layout ESP-PPQ reads."""
    feeds = tf_to_tflite_int8.calibration_samples(run, None, samples)
    return [torch.from_numpy(np.ascontiguousarray(next(iter(f.values())).transpose(0, 3, 1, 2)))
            for f in feeds]


def setting(equalize: bool = True):
    from esp_ppq.api.setting import QuantizationSettingFactory

    chosen = QuantizationSettingFactory.espdl_setting()
    chosen.equalization = equalize
    chosen.equalization_setting.iterations = EQUALIZATION_ITERATIONS
    chosen.equalization_setting.value_threshold = EQUALIZATION_THRESHOLD
    chosen.equalization_setting.opt_level = EQUALIZATION_OPT_LEVEL
    return chosen


def quantize(onnx_path: Path, calib: list[torch.Tensor], out: Path, equalize: bool = True,
             export: bool = True):
    """Quantise and, unless export is off, write out plus the .info and .json beside it."""
    from esp_ppq.api import espdl_quantize_onnx

    out.parent.mkdir(parents=True, exist_ok=True)
    return espdl_quantize_onnx(
        onnx_import_file=str(onnx_path), espdl_export_file=str(out),
        calib_dataloader=calib, calib_steps=len(calib), input_shape=list(calib[0].shape),
        target=TARGET, num_of_bits=BITS, collate_fn=lambda batch: batch.to("cpu"),
        setting=setting(equalize), device="cpu", error_report=False, skip_export=not export,
        export_test_values=export, verbose=0,
    )


class Simulator:
    """The quantised graph run by ESP-PPQ's executor: the numbers the chip produces."""

    batched = True

    def __init__(self, graph) -> None:
        from esp_ppq.executor.torch import TorchExecutor

        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.executor = TorchExecutor(graph=graph, device=self.device)

    def __call__(self, x: np.ndarray) -> list[np.ndarray]:
        """x is float NCHW; outputs come back in the ONNX graph's order."""
        inputs = torch.from_numpy(np.ascontiguousarray(x)).to(self.device)
        return [t.detach().cpu().numpy() for t in self.executor.forward(inputs=inputs)]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True, help="the .espdl to write")
    parser.add_argument("--work", type=Path, required=True, help="scratch for the folded onnx")
    parser.add_argument("--samples", type=int, default=300)
    parser.add_argument("--no-equalization", action="store_true")
    args = parser.parse_args(argv)

    onnx_path = export_onnx(args.run, args.work / "folded.onnx")
    calib = calibration(args.run, args.samples)
    quantize(onnx_path, calib, args.out, equalize=not args.no_equalization)
    size = args.out.stat().st_size
    print(f"Q1 espdl  {args.out.name}  {size / 1024.0:.1f} KB  calib {len(calib)} x "
          f"{tuple(calib[0].shape)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
