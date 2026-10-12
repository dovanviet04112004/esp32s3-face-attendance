"""The ESP-DL ladder's writer (KEHOACH 3.7): a quantised graph as .espdl and as a native file.

A later step reads the native file back without quantising again. The .espdl carries a test pair
for model->test() simulated from a real frame, never random numbers.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch

from . import espdl_shapes
from .ptq_espdl import BITS, TARGET

# Of ESP-PPQ's passive ops esp-dl rescales only in these; the rest copy integers across exponents.
RESCALING_PASSIVE = frozenset({"ReduceMax", "ReduceMin"})


def rescales(given, config) -> bool:
    """config quantises at another scale or width than given; with no scale it quantises nothing."""
    if given.scale is None or config.scale is None:
        return False
    return config.num_of_bits != given.num_of_bits or not torch.equal(
        config.scale.flatten(), given.scale.flatten()
    )


def rescaling_passive_ops(graph) -> list[str]:
    """graph's passive ops whose output scale or width is not the input's: rescales esp-dl skips."""
    from esp_ppq.core import PASSIVE_OPERATIONS
    from esp_ppq.IR.quantize import QuantableOperation

    copying = PASSIVE_OPERATIONS - RESCALING_PASSIVE
    return [
        op.name
        for op in graph.operations.values()
        if op.type in copying
        and isinstance(op, QuantableOperation)
        and any(rescales(op.input_quant_config[0], config) for config in op.output_quant_config)
    ]


def export(graph, out: Path, test_input: np.ndarray) -> Path:
    """Write out as .espdl with its .info and .json, carrying test_input and its simulated outputs.

    test_input is float NCHW on the input's int8 grid. Refused when a passive op rescales or esp-dl
    would build another shape than ESP-PPQ simulates (espdl_shapes).
    """
    import esp_ppq.lib as ppq_lib
    from esp_ppq.api.espdl_interface import generate_test_value, get_target_platform

    rescaling = rescaling_passive_ops(graph)
    if rescaling:
        raise ValueError(
            f"{rescaling} rescale at their output, which esp-dl's passive modules never do"
        )
    tensor = torch.from_numpy(np.ascontiguousarray(test_input, dtype=np.float32))
    values = generate_test_value(graph, "cpu", [tensor])
    out.parent.mkdir(parents=True, exist_ok=True)
    ppq_lib.Exporter(platform=get_target_platform(TARGET, BITS)).export(
        file_path=str(out), graph=graph, values_for_test=values, export_config=True
    )
    espdl_shapes.check(out.with_suffix(".info"))
    return out


def save_native(graph, out: Path) -> Path:
    """graph as ESP-PPQ's native file: every operation, parameter and quantisation config."""
    from esp_ppq.parser import NativeExporter

    out.parent.mkdir(parents=True, exist_ok=True)
    NativeExporter().export(file_path=str(out), graph=graph)
    return out


def load_native(path: Path):
    """The graph save_native wrote."""
    from esp_ppq.api import load_native_graph

    return load_native_graph(str(path))
