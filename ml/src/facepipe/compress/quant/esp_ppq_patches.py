"""Fixes to ESP-PPQ 1.3.11, each in force only for the branches whose block in quant.yaml names it.

A patch enters around every place its branch uses ESP-PPQ: quantising, simulating and exporting
(KEHOACH 3.7). Each one records the board symptom it answers and has a test pinning it. A patch that
has the chip round another way simulates that rounding too, so the ruler scores the chip's integers.
"""

from __future__ import annotations

import contextlib
import math
from collections.abc import Callable, Iterator, Sequence

import torch

from .espdl_profile import CHANNEL_STEP, chip
from .espdl_shapes import FUSED_PRELU


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


ZERO_KEEPING = frozenset({"PRelu", "Relu", "LeakyRelu", "Clip"})


def padded(channels: int) -> int:
    return -(-channels // CHANNEL_STEP) * CHANNEL_STEP


def clip_bounds(op) -> tuple[float, float]:
    """A Clip's lower and upper bound, unbounded where one is left out."""

    def bound(index: int, name: str, missing: float) -> float:
        if len(op.inputs) > index and op.inputs[index].value is not None:
            return float(op.inputs[index].value)
        return float(op.attributes.get(name, missing))

    return bound(1, "min", float("-inf")), bound(2, "max", float("inf"))


def keeps_zero(op) -> bool:
    """op maps 0 to 0 in every channel, so a channel of zeros stays one through it."""
    if op.type != "Clip":
        return op.type in ZERO_KEEPING
    low, high = clip_bounds(op)
    return low <= 0 <= high


def per_tensor(op) -> bool:
    configs = [*getattr(op, "input_quant_config", []), *getattr(op, "output_quant_config", [])]
    return all(c.scale is None or c.scale.numel() == 1 for c in configs)


def per_channel(op, channels: int) -> bool:
    """op works on each of the channels alone and keeps a channel of zeros at zero."""
    if op.type == "Conv":
        return op.attributes.get("group", 1) == channels == op.inputs[1].value.shape[0]
    return keeps_zero(op)


def channel_path(graph, conv) -> tuple[list, list] | None:
    """The ops conv's output channels go through one by one, and the ungrouped Convs summing them.

    None when a reader does anything else with them, or one of their tensors leaves the graph.
    """
    channels, frontier = conv.inputs[1].value.shape[0], [conv.outputs[0]]
    middle, ends = [], []
    while frontier:
        var = frontier.pop()
        if var.name in graph.outputs or not var.dest_ops:
            return None
        for reader in var.dest_ops:
            if reader.inputs[0] is not var or not per_tensor(reader):
                return None
            if reader.type == "Conv" and reader.attributes.get("group", 1) == 1:
                ends.append(reader)
            elif per_channel(reader, channels):
                middle.append(reader)
                frontier.append(reader.outputs[0])
            else:
                return None
    return middle, ends


def zero_rows(var, size: int, dim: int = 0) -> None:
    """var's parameter grown along dim to size with zeros."""
    extra = list(var.value.shape)
    extra[dim] = size - extra[dim]
    var.value = torch.cat([var.value, var.value.new_zeros(extra)], dim=dim)


def widen(var, size: int) -> None:
    var.shape = [var.shape[0], size, *var.shape[2:]]


def pad_channels(graph, conv) -> bool:
    """conv's output channels, and the path channel_path finds for them, grown to a multiple of 16
    with zeros: zero filters, biases and slopes, and zero weight columns where they are summed.
    """
    if conv.type != "Conv" or conv.attributes.get("group", 1) != 1 or not per_tensor(conv):
        return False
    channels = conv.inputs[1].value.shape[0]
    if not channels % CHANNEL_STEP or not conv.inputs[1].is_parameter:
        return False
    path = channel_path(graph, conv)
    if path is None:
        return False
    middle, ends = path
    size = padded(channels)
    for var in conv.inputs[1:]:
        zero_rows(var, size)
    widen(conv.outputs[0], size)
    for op in middle:
        if op.type == "Conv":
            for var in op.inputs[1:]:
                zero_rows(var, size)
            op.attributes["group"] = size
        elif op.type == "PRelu" and op.inputs[1].value.numel() == channels:
            zero_rows(op.inputs[1], size)
        widen(op.outputs[0], size)
    for op in ends:
        zero_rows(op.inputs[1], size, dim=1)
    return True


@contextlib.contextmanager
def padded_channels() -> Iterator[None]:
    """Each ungrouped Conv's unaligned output channels padded to a multiple of 16 on their path.

    esp-dl's S3 kernels take channels sixteen at a time, and a remainder sends the whole convolution
    down a slower path (latency.md 14.2). The zeros add nothing, so no integer changes.
    """
    from esp_ppq.parser import espdl_exporter

    prepare = espdl_exporter.EspdlExporter.prepare_graph

    def padding(self, graph, *args, **kwargs):
        for op in list(graph.topological_sort()):
            pad_channels(graph, op)
        return prepare(self, graph, *args, **kwargs)

    espdl_exporter.EspdlExporter.prepare_graph = padding
    try:
        yield
    finally:
        espdl_exporter.EspdlExporter.prepare_graph = prepare


PRELU_MARK = "PRelu"


def one_grid(*configs) -> bool:
    """Every config quantises on the same per-tensor grid."""
    return len({float(config.scale) for config in configs}) == 1


def int8(configs) -> bool:
    return all(config.num_of_bits == 8 for config in configs)


def fusable(prelu) -> bool:
    """prelu, a PRelu, applied by esp-dl's S3 kernels where its 2-D Conv rounds: that Conv's lone
    reader, an int8 slope a channel on a fractional grid, the Conv's output grid kept throughout.
    """
    from esp_ppq.IR.quantize import QuantableOperation

    if prelu.type != "PRelu" or not isinstance(prelu, QuantableOperation):
        return False
    conv, slope = prelu.inputs[0].source_op, prelu.inputs[1]
    if not (
        isinstance(conv, QuantableOperation)
        and conv.type == "Conv"
        and conv.inputs[1].is_parameter
        and conv.inputs[1].value.dim() == 4
        and len(prelu.inputs[0].dest_ops) == 1
        and slope.is_parameter
        and slope.value.numel() == conv.inputs[1].value.shape[0]
    ):
        return False
    grid = [conv.output_quant_config[0], *prelu.input_quant_config[:1], *prelu.output_quant_config]
    slope_config = prelu.input_quant_config[1]
    return (
        int8([*conv.input_quant_config[:2], *grid, slope_config])
        and one_grid(*grid)
        and float(slope_config.scale) < 1
    )


def chip_prelu(op, values: list, ctx=None, **kwargs):
    """ESP-PPQ's PRelu, with a fusable one's negative side as EE.VPRELU.S8 leaves it: the int8
    product shifted right, so floored; the gradient passes straight through.
    """
    from esp_ppq.core import QuantizationStates
    from esp_ppq.executor.op.torch.default import PRelu_forward

    y = PRelu_forward(op, values, ctx, **kwargs)
    if not QuantizationStates.is_activated(op.output_quant_config[0].state) or not fusable(op):
        return y
    step = op.output_quant_config[0].scale.to(y.device)
    floored = torch.floor(y / step) * step
    return torch.where(values[0] < 0, y + (floored - y).detach(), y)


def fuse_prelu(graph, op) -> bool:
    """op, a Conv, joined to the PRelu that alone reads it when that PRelu is fusable.

    The slope rides on as op's last input, one value a channel; export_graph renames the pair.
    """
    from esp_ppq.core import OperationQuantizationConfig
    from esp_ppq.parser.espdl.espdl_graph_utils import fuse_downstream_operation

    readers = graph.get_downstream_operations(op) if op.name in graph.operations else []
    if op.type != "Conv" or len(readers) != 1 or not fusable(readers[0]):
        return False
    if op.outputs[0].name in graph.outputs:
        raise ValueError(
            f"{op.name} writes a graph output, so the PRelu simulated on it stays apart"
        )
    prelu = readers[0]
    slope = prelu.inputs[1]
    slope_config, out_config = prelu.input_quant_config[1], prelu.output_quant_config[0]
    prelu.inputs.remove(slope)
    slope.dest_ops.remove(prelu)
    fuse_downstream_operation(graph, prelu, keep_coherence=True)
    slope.value = slope.value.reshape(-1)
    op.inputs.append(slope)
    slope.dest_ops.append(op)
    op.config = OperationQuantizationConfig([*op.input_quant_config, slope_config], [out_config])
    op.attributes["activation"] = PRELU_MARK
    return True


@contextlib.contextmanager
def fused_prelu() -> Iterator[None]:
    """Each fusable PRelu simulated as the S3 kernel applies it and exported inside its Conv.

    esp-dl 3.3.11's Conv leaves the PReLU slope empty, so the pair leaves as ConvPRelu, the module
    ai_engine registers; esp-dl's own PRelu rounds half up, the fused kernel floors (KEHOACH 3.7).
    """
    from esp_ppq.core import TargetPlatform
    from esp_ppq.executor.base import OPERATION_FORWARD_TABLE
    from esp_ppq.parser import espdl_exporter
    from esp_ppq.parser.espdl import export_patterns

    table = OPERATION_FORWARD_TABLE[TargetPlatform.ESPDL_S3_INT8]
    simulated = table["PRelu"]
    joined = export_patterns.FuseReluLikePattern.export
    write = espdl_exporter.EspdlExporter.export_graph

    def joining(self, op, graph, **kwargs):
        op = joined(self, op, graph, **kwargs)
        fuse_prelu(graph, op)
        return op

    def writing(self, graph, *args, **kwargs):
        for op in graph.operations.values():
            if op.type == "Conv" and op.attributes.get("activation") == PRELU_MARK:
                op.type = FUSED_PRELU
        return write(self, graph, *args, **kwargs)

    table["PRelu"] = chip_prelu
    export_patterns.FuseReluLikePattern.export = joining
    espdl_exporter.EspdlExporter.export_graph = writing
    try:
        yield
    finally:
        table["PRelu"] = simulated
        export_patterns.FuseReluLikePattern.export = joined
        espdl_exporter.EspdlExporter.export_graph = write


PATCHES: dict[str, Callable[[], contextlib.AbstractContextManager[None]]] = {
    "cache_sized_convolutions": cache_sized_convolutions,
    "fused_prelu": fused_prelu,
    "padded_channels": padded_channels,
}
# Patches that change an integer the chip computes: ladder variants only (KEHOACH 3.7).
ROUNDING = frozenset({"fused_prelu"})


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
