"""Fixes to ESP-PPQ 1.3.11, each in force only for the branches whose block in quant.yaml names it.

A patch enters around every place its branch uses ESP-PPQ: quantising, simulating and exporting
(KEHOACH 3.7). Each one records the board symptom it answers and has a test pinning it; an export
patch only drops work ESP-PPQ leaves for the chip and never changes an integer of the graph.
"""

from __future__ import annotations

import contextlib
import math
from collections.abc import Callable, Iterator, Sequence

from .espdl_profile import CHANNEL_STEP, chip


def laid_shape(var, info) -> list[int]:
    """var's shape as the export lays it in the chip's memory."""
    perm = info.get_var_permute(var.name)
    return [var.shape[i] for i in perm] if perm else list(var.shape)


def linked(graph, op, inputs: list, outputs: list):
    """op, quantised and with no variables yet, registered in graph and linked to its variables."""
    graph.operations[op.name] = op
    for var in inputs:
        op.inputs.append(var)
        var.dest_ops.append(op)
    for var in outputs:
        op.outputs.append(var)
        var.source_op = op
    return op


def output_sizes(outputs: int, weight_bytes: int, weight_bytes_max: int) -> list[int]:
    """Slices of outputs, each a multiple of CHANNEL_STEP holding at most weight_bytes_max.

    The slices are as even as that allows; one slice when the outputs cannot be cut so.
    """
    per_output = weight_bytes // outputs
    step = max(weight_bytes_max // per_output // CHANNEL_STEP, 1) * CHANNEL_STEP
    if outputs % CHANNEL_STEP or outputs <= step:
        return [outputs]
    size = -(-outputs // -(-outputs // step) // CHANNEL_STEP) * CHANNEL_STEP
    return [size] * (outputs // size) + ([outputs % size] if outputs % size else [])


def slice_outputs(graph, op, sizes: list[int], info) -> None:
    """op, an ungrouped pointwise convolution, as one convolution per slice of its outputs.

    Each slice takes its rows of the weights and bias on op's grids, and a Concat on op's output
    grid lays the slices back along the channels into op's output.
    """
    from esp_ppq.core import OperationQuantizationConfig
    from esp_ppq.IR.quantize import QuantableOperation
    from esp_ppq.parser.espdl.espdl_graph_utils import get_default_perm

    (x, *params), y, platform = op.inputs, op.outputs[0], op.platform
    configs, out_config, laid = (
        op.input_quant_config,
        op.output_quant_config[0],
        laid_shape(y, info),
    )
    values = [p.value for p in params]
    attributes = dict(op.attributes)
    graph.remove_operation(op)
    parts, start = [], 0
    for size in sizes:
        sliced = []
        for value, config in zip(values, configs[1:], strict=True):
            param = graph.create_variable(
                value=value[start : start + size].clone(), is_parameter=True
            )
            config = config.copy()
            if config.scale is not None and config.scale.dim() > 0:
                config.scale = config.scale[start : start + size]
                config.offset = config.offset[start : start + size]
            sliced.append((param, config))
        part = graph.create_variable()
        part.shape, part.dtype = [*laid[:-1], size], y.dtype
        info.add_var_permute(part.name, get_default_perm(part))
        conv = graph.create_operation(op_type="Conv", attributes=dict(attributes))
        config = OperationQuantizationConfig([configs[0], *(c for _, c in sliced)], [out_config])
        quantised = QuantableOperation(conv, config, platform)
        linked(graph, quantised, [x, *(p for p, _ in sliced)], [part])
        parts.append(part)
        start += size
    concat = graph.create_operation(op_type="Concat", attributes={"axis": len(laid) - 1})
    config = OperationQuantizationConfig([out_config] * len(parts), [out_config])
    linked(graph, QuantableOperation(concat, config, platform), parts, [y])


def slice_wide_convolutions(graph, cache_bytes: int) -> int:
    """Each ungrouped pointwise convolution over several positions whose weights fill cache_bytes.

    slice_outputs lays each by output_sizes into slices of at most half of it; returns how many.
    """
    from esp_ppq.IR.quantize import QuantableOperation
    from esp_ppq.parser.espdl.espdl_typedef import ExporterPatternInfo

    info, done = ExporterPatternInfo(), 0
    for op in list(graph.topological_sort()):
        if not isinstance(op, QuantableOperation) or op.type != "Conv":
            continue
        if op.attributes.get("group", 1) != 1:
            continue
        w, laid = op.inputs[1].value, laid_shape(op.outputs[0], info)
        if any(k != 1 for k in op.attributes["kernel_shape"]) or math.prod(laid[:-1]) < 2:
            continue
        if w.numel() >= cache_bytes:
            slice_outputs(graph, op, output_sizes(laid[-1], w.numel(), cache_bytes // 2), info)
            done += 1
    return done


@contextlib.contextmanager
def cache_sized_convolutions() -> Iterator[None]:
    """Pointwise convolutions whose weights fill the data cache, run as slices within half of it.

    esp-dl reads all of a pointwise convolution's weights again at each position, so 64 KB of them
    come from PSRAM each time: recognition's 128 -> 512 ran 0.64-0.75 cycles a multiply-add against
    0.13-0.25 for 38 KB or less (latency.md 14). The slices give the same integers.
    """
    from esp_ppq.parser import espdl_exporter

    cache_bytes = chip()[1]
    reset = espdl_exporter.reset_graph_layout

    def sliced(graph):
        reset(graph)
        slice_wide_convolutions(graph, cache_bytes)

    espdl_exporter.reset_graph_layout = sliced
    try:
        yield
    finally:
        espdl_exporter.reset_graph_layout = reset


PATCHES: dict[str, Callable[[], contextlib.AbstractContextManager[None]]] = {
    "cache_sized_convolutions": cache_sized_convolutions,
}


@contextlib.contextmanager
def applied(names: Sequence[str]) -> Iterator[None]:
    """Every patch of names in force, entered in the order given and undone in reverse."""
    unknown = [name for name in names if name not in PATCHES]
    if unknown:
        raise ValueError(f"no ESP-PPQ patch named {unknown}; known: {sorted(PATCHES)}")
    with contextlib.ExitStack() as stack:
        for name in names:
            stack.enter_context(PATCHES[name]())
        yield
