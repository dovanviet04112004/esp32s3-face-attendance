"""Rungs 1 and 2 of the ESP-DL ladder (KEHOACH 3.7): ESP-PPQ quantises a run's graph for the S3.

The ONNX is held to torch on a real sample before anything is quantised, every port must carry a
power-of-two exponent, and the Simulator runs the int8 graph as the chip computes it under the
fixes its branch names. model->test() and the board probe hold the chip to it bit for bit at int8.
"""

from __future__ import annotations

import contextlib
import copy
import math
import tempfile
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import yaml

from ... import ML_ROOT, REPO_ROOT, tasks
from ...export import to_onnx
from . import esp_ppq_patches, fold_bn

TARGET = "esp32s3"
BITS = 8
WIDE_BITS = 16
INT8_MIN, INT8_MAX = -128, 127
LADDER = ML_ROOT / "configs" / "common" / "quant.yaml"
TIMING_ROW = "timing"


@dataclass(frozen=True)
class Port:
    """One graph input or output: its width, and its exponent, value = integer * 2^exponent."""

    name: str
    exponent: int
    bits: int


def load_ladder() -> dict:
    return yaml.safe_load(LADDER.read_text(encoding="utf-8"))


def block(branch: str) -> dict:
    """The branch's block of quant.yaml: rungs, ladder, patches, probe, chosen row."""
    return load_ladder()["branches"][branch]


def ladder(branch: str) -> dict:
    """The branch's rungs over the default ones."""
    cfg = load_ladder()
    return {**cfg["default"], **cfg["branches"][branch]["rungs"]}


def timing_rungs(branch: str) -> dict:
    """The branch's rungs under the timing row, quick to quantise (KEHOACH 3.7 step 2.1)."""
    return {**ladder(branch), **load_ladder()["timing"]}


def setting_of(rungs: dict):
    """The ESP-PPQ setting rungs describe: equalization, bias correction, calibration, int16 ops."""
    from esp_ppq.api.espdl_interface import get_target_platform
    from esp_ppq.api.setting import QuantizationSettingFactory

    setting = QuantizationSettingFactory.espdl_setting(BITS)
    equalization = rungs["equalization"]
    setting.equalization = equalization is not None
    if equalization is not None:
        setting.equalization_setting.iterations = equalization["iterations"]
        setting.equalization_setting.value_threshold = equalization["value_threshold"]
        setting.equalization_setting.opt_level = equalization["opt_level"]
    setting.bias_correct = rungs["bias_correction"]
    setting.quantize_activation_setting.calib_algorithm = rungs["calibration"]
    for op in rungs["int16_ops"]:
        setting.dispatching_table.append(op, get_target_platform(TARGET, WIDE_BITS))
    return setting


def calibration(run: Path, samples: int) -> list[torch.Tensor]:
    """The branch's calibration set as NCHW batches of one, the layout ESP-PPQ reads."""
    feeds = tasks.calibration_samples(run, None, samples)
    return [
        torch.from_numpy(np.ascontiguousarray(next(iter(f.values())).transpose(0, 3, 1, 2)))
        for f in feeds
    ]


def export_onnx(run: Path, out: Path, feed: torch.Tensor, rtol: float, model=None) -> Path:
    """The run's float graph, or model built for the run, as ONNX with Linear + BatchNorm1d folded.

    ESP-PPQ cannot parse that pair. Refused when onnxruntime and torch differ on feed beyond rtol.
    """
    chosen = copy.deepcopy(model if model is not None else tasks.load_run(run)[1]).eval()
    fold_bn.fold_linear(chosen)
    evaluator = tasks.module_of(run, "eval")
    _, traced, _example, input_names, output_names = evaluator.export_spec(run, chosen)
    if len(input_names) != 1:
        raise ValueError(
            f"{run.name}: the ladder quantises one-input graphs, this one reads {input_names}"
        )
    out.parent.mkdir(parents=True, exist_ok=True)
    # Traced at feed's batch: ESP-PPQ keeps the traced batch in every Reshape (qat_espdl).
    torch.onnx.export(
        traced,
        (feed,),
        str(out),
        opset_version=to_onnx.OPSET,
        input_names=input_names,
        output_names=output_names,
        dynamo=False,
    )
    found = to_onnx.agreement(traced, out, (feed,), relative=True)
    if found > rtol:
        raise ValueError(
            f"{out}: onnxruntime is off torch by {found:.3g} of an output, over {rtol}"
        )
    return out


def quantize(run: Path, calib: list[torch.Tensor], work: Path, rungs: dict, model=None):
    """The run's float model quantised under rungs on calib; work keeps the ONNX, held to torch."""
    onnx_path = export_onnx(run, work / "graph.onnx", calib[0], rungs["onnx_rtol"], model)
    return quantize_onnx(onnx_path, calib, work, rungs)


def quantize_onnx(onnx_path: Path, calib: list[torch.Tensor], work: Path, rungs: dict):
    """The ESP-PPQ graph of onnx_path for the S3 under rungs, calibrated on calib's batches."""
    from esp_ppq.api import espdl_quantize_onnx

    return espdl_quantize_onnx(
        onnx_import_file=str(onnx_path),
        espdl_export_file=str(work / "graph.espdl"),
        calib_dataloader=calib,
        calib_steps=len(calib),
        input_shape=list(calib[0].shape),
        target=TARGET,
        num_of_bits=BITS,
        collate_fn=lambda batch: batch.to("cpu"),
        setting=setting_of(rungs),
        device="cpu",
        error_report=False,
        skip_export=True,
        verbose=0,
    )


def exponent_of(config) -> int:
    """log2 of a tensor's quantisation scale, which esp-dl requires to be a power of two."""
    scale = float(config.scale)
    exponent = round(math.log2(scale))
    if 2.0**exponent != scale:
        raise ValueError(f"scale {scale} is not a power of two")
    return exponent


def ports_of(graph) -> tuple[list[Port], list[Port]]:
    """Each input as its first reader quantises it, each output as its producer does, in order."""

    def port(name: str, config) -> Port:
        return Port(name, exponent_of(config), config.num_of_bits)

    def read(name: str, var) -> Port:
        reader = var.dest_ops[0]
        return port(name, reader.input_quant_config[reader.inputs.index(var)])

    def written(name: str, var) -> Port:
        producer = var.source_op
        return port(name, producer.output_quant_config[producer.outputs.index(var)])

    inputs = [read(name, var) for name, var in graph.inputs.items()]
    return inputs, [written(name, var) for name, var in graph.outputs.items()]


def port_bits(graph) -> set[int]:
    """The widths the graph's inputs and outputs carry: 16 where a layer at an end went int16."""
    inputs, outputs = ports_of(graph)
    return {port.bits for port in (*inputs, *outputs)}


def to_int8(x: np.ndarray, exponent: int) -> np.ndarray:
    return np.clip(np.rint(x / 2.0**exponent), INT8_MIN, INT8_MAX).astype(np.int8)


class Simulator:
    """The quantised graph run by ESP-PPQ's executor under the fixes its branch names: the numbers
    the chip computes."""

    batched = True

    def __init__(self, graph, patches: Sequence[str] = (), device: str | None = None) -> None:
        from esp_ppq.executor.torch import TorchExecutor

        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.executor = TorchExecutor(graph=graph, device=self.device)
        self.patches = list(patches)

    def __call__(self, x: np.ndarray) -> list[np.ndarray]:
        """x is float NCHW; outputs come back in the graph's order."""
        inputs = torch.from_numpy(np.ascontiguousarray(x, dtype=np.float32)).to(self.device)
        with esp_ppq_patches.applied(self.patches):
            outs = self.executor.forward(inputs=inputs)
        return [t.detach().cpu().numpy() for t in outs]


@contextlib.contextmanager
def unregistered() -> Iterator[None]:
    """Registry decorators that leave the registry alone, so a module imported a second time from
    another commit keeps its classes without clashing with the ones in use."""
    from facepipe.core import registry

    kept = registry.Registry.register
    registry.Registry.register = lambda self, name=None: lambda obj: obj
    try:
        yield
    finally:
        registry.Registry.register = kept


def at_commit(module_name: str, against: str):
    """The module module_name as its file stands at commit against, imported anew beside the one in
    use; None when the file reads as it does now, so a branch's same-int8 has nothing to check."""
    import importlib.util
    import subprocess
    import sys

    here = Path(importlib.util.find_spec(module_name).origin).resolve()
    shown = subprocess.run(
        ["git", "show", f"{against}:{here.relative_to(REPO_ROOT).as_posix()}"],
        cwd=REPO_ROOT,
        capture_output=True,
    )
    if shown.returncode != 0:
        raise ValueError(f"{against}: {shown.stderr.decode().strip()}")
    if shown.stdout == here.read_bytes():
        return None
    with tempfile.TemporaryDirectory() as folder:
        copy_path = Path(folder) / here.name
        copy_path.write_bytes(shown.stdout)
        spec = importlib.util.spec_from_file_location(f"{module_name}_at_{against}", copy_path)
        module = importlib.util.module_from_spec(spec)
        # Relative imports of the old file resolve against the package in use.
        module.__package__ = module_name.rpartition(".")[0]
        sys.modules[spec.name] = module
        with unregistered():
            spec.loader.exec_module(module)
    return module


def same_integers(
    run: Path,
    models: Sequence[torch.nn.Module],
    calib: list[torch.Tensor],
    inputs: Sequence[np.ndarray],
    rungs: dict,
    patches: Sequence[str],
) -> tuple[int, float]:
    """How many simulated outputs of models, each quantised under rungs and patches on calib, differ
    from the first model's on inputs, and by how much at most: (0, 0.0) when a rewrite between them
    keeps every integer (KEHOACH 3.7 step 2.4)."""
    outs = []
    for model in models:
        with esp_ppq_patches.applied(patches), tempfile.TemporaryDirectory() as work:
            graph = quantize(run, calib, Path(work), rungs, model)
        simulator = Simulator(graph, patches, device="cpu")
        outs.append(np.concatenate([o.ravel() for x in inputs for o in simulator(x)]))
    first, rest = outs[0], outs[1:]
    off = sum(int((first != other).sum()) for other in rest)
    return off, max((float(np.abs(first - other).max()) for other in rest), default=0.0)
