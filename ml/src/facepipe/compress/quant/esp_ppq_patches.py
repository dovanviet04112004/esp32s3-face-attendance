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
from .espdl_shapes import CHANNEL_CONV, FUSED_PRELU, IM2COL_CONV, MUL_ADD, SLICED_CONV


def laid_shape(var, info) -> list[int]:
    """var's shape as the export lays it in the chip's memory."""
    perm = info.get_var_permute(var.name)
    return [var.shape[i] for i in perm] if perm else list(var.shape)


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


SLICES_MARK = "slices"


def slice_into(graph, op, sizes: list[int]) -> None:
    """op, an ungrouped pointwise convolution, carrying one set of parameters per slice of outputs.

    Each slice takes its rows of every parameter on op's grids, for ConvSlices to run them.
    """
    from esp_ppq.core import OperationQuantizationConfig

    params, configs = op.inputs[1:], op.input_quant_config
    sliced, start = [], 0
    for size in sizes:
        for var, config in zip(params, configs[1:], strict=True):
            part = graph.create_variable(
                value=var.value[start : start + size].clone(), is_parameter=True
            )
            config = config.copy()
            if config.scale is not None and config.scale.dim() > 0:
                config.scale = config.scale[start : start + size]
                config.offset = config.offset[start : start + size]
            sliced.append((part, config))
        start += size
    for var in params:
        var.dest_ops.remove(op)
        graph.remove_variable(var)
    del op.inputs[1:]
    for part, _config in sliced:
        op.inputs.append(part)
        part.dest_ops.append(op)
    op.config = OperationQuantizationConfig(
        [configs[0], *(config for _part, config in sliced)], op.output_quant_config
    )
    op.attributes[SLICES_MARK] = list(sizes)


def slice_wide_convolutions(graph, cache_bytes: int) -> int:
    """Each ungrouped pointwise convolution over several positions whose weights fill cache_bytes.

    slice_into lays each by output_sizes into slices of at most half of it; returns how many.
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
            slice_into(graph, op, output_sizes(laid[-1], w.numel(), cache_bytes // 2))
            done += 1
    return done


@contextlib.contextmanager
def cache_sized_convolutions() -> Iterator[None]:
    """Pointwise convolutions whose weights fill the data cache, run as slices within half of it.

    esp-dl reads a pointwise convolution's weights again at each position, so 64 KB of them come
    from PSRAM each time (latency.md 14.2). ConvSlices writes each slice into its channels of the
    output, so the integers are the same and no Concat copies them.
    """
    from esp_ppq.parser import espdl_exporter

    cache_bytes = chip()[1]
    reset = espdl_exporter.reset_graph_layout
    write = espdl_exporter.EspdlExporter.export_graph

    def sliced(graph):
        reset(graph)
        slice_wide_convolutions(graph, cache_bytes)

    def writing(self, graph, *args, **kwargs):
        for op in graph.operations.values():
            if op.type == "Conv" and SLICES_MARK in op.attributes:
                op.type = SLICED_CONV
        return write(self, graph, *args, **kwargs)

    espdl_exporter.reset_graph_layout = sliced
    espdl_exporter.EspdlExporter.export_graph = writing
    try:
        yield
    finally:
        espdl_exporter.reset_graph_layout = reset
        espdl_exporter.EspdlExporter.export_graph = write


def lone_reader(var):
    """The one op reading var, None when there are more or none."""
    return var.dest_ops[0] if len(var.dest_ops) == 1 else None


def eca_chain(graph, conv) -> list | None:
    """The ECA chain around conv, a 1-D Conv over channels: Squeeze, Transpose, conv, Transpose and
    Unsqueeze between two 1x1 maps, each tensor between them read once; None for any other Conv.
    """
    weight = conv.inputs[1] if len(conv.inputs) == 2 else None
    if conv.type != "Conv" or weight is None or not weight.is_parameter:
        return None
    if list(weight.value.shape[:2]) != [1, 1] or weight.value.dim() != 3:
        return None
    if conv.attributes.get("strides", [1]) != [1] or conv.attributes.get("dilations", [1]) != [1]:
        return None
    first = conv.inputs[0].source_op
    squeeze = first.inputs[0].source_op if first is not None else None
    second = lone_reader(conv.outputs[0])
    unsqueeze = lone_reader(second.outputs[0]) if second is not None else None
    chain = [squeeze, first, conv, second, unsqueeze]
    if [op.type if op is not None else None for op in chain] != [
        "Squeeze", "Transpose", "Conv", "Transpose", "Unsqueeze",
    ]:  # fmt: skip
        return None
    inner = [op.outputs[0] for op in chain[:-1]]
    if any(lone_reader(var) is None or var.name in graph.outputs for var in inner):
        return None
    x, y = squeeze.inputs[0], unsqueeze.outputs[0]
    if len(x.shape) != 4 or x.shape[2:] != [1, 1] or y.shape != x.shape:
        return None
    return chain


def channel_conv_from(graph, conv) -> bool:
    """conv's ECA chain replaced by one ChannelConv op on the same weight and grids."""
    from esp_ppq.core import OperationQuantizationConfig
    from esp_ppq.IR.quantize import QuantableOperation

    chain = eca_chain(graph, conv)
    if chain is None:
        return False
    squeeze, unsqueeze = chain[0], chain[-1]
    x, y, weight = squeeze.inputs[0], unsqueeze.outputs[0], conv.inputs[1]
    config = OperationQuantizationConfig(
        [squeeze.input_quant_config[0], conv.input_quant_config[1]], [conv.output_quant_config[0]]
    )
    attributes = {key: list(conv.attributes[key]) for key in ("kernel_shape", "pads")}
    conv.inputs.remove(weight)
    weight.dest_ops.remove(conv)
    inner = [op.outputs[0] for op in chain[:-1]]
    for op in chain:
        graph.remove_operation(op)
    for var in inner:
        graph.remove_variable(var)
    op = QuantableOperation(
        graph.create_operation(op_type=CHANNEL_CONV, attributes=attributes), config, conv.platform
    )
    graph.operations[op.name] = op
    for var in (x, weight):
        op.inputs.append(var)
        var.dest_ops.append(op)
    op.outputs.append(y)
    y.source_op = op
    return True


@contextlib.contextmanager
def channel_conv() -> Iterator[None]:
    """Each ECA chain exported as one ChannelConv, laid out like a passive op (KEHOACH 3.7).

    The chain runs a 1-D convolution over C values; as a 1x1xC map it has one byte order in either
    layout, so the export needs none of the four Transposes and Squeezes around it.
    """
    from esp_ppq.parser import espdl_exporter
    from esp_ppq.parser.espdl.espdl_typedef import PASSIVE_LAYOUT_OP_SET

    prepare = espdl_exporter.EspdlExporter.prepare_graph

    def rewriting(self, graph, *args, **kwargs):
        for op in list(graph.topological_sort()):
            if op.name in graph.operations:
                channel_conv_from(graph, op)
        return prepare(self, graph, *args, **kwargs)

    PASSIVE_LAYOUT_OP_SET.add(CHANNEL_CONV)
    espdl_exporter.EspdlExporter.prepare_graph = rewriting
    try:
        yield
    finally:
        PASSIVE_LAYOUT_OP_SET.discard(CHANNEL_CONV)
        espdl_exporter.EspdlExporter.prepare_graph = prepare


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


IM2COL_MARK = "im2col"


def patch_weight(weight: torch.Tensor) -> torch.Tensor:
    """A [N, C, kh, kw] filter as the [N, P, 1, 1] one ConvIm2col runs over output pixels' patches.

    A patch runs kernel row, then column, then channel; P pads kh*kw*C with zero columns to 16.
    """
    outputs = weight.shape[0]
    patches = weight.permute(0, 2, 3, 1).reshape(outputs, -1)
    columns = patches.new_zeros(outputs, padded(patches.shape[1]) - patches.shape[1])
    return torch.cat([patches, columns], dim=1).reshape(outputs, -1, 1, 1)


def im2col_ready(op) -> bool:
    """op, an int8 per-tensor ungrouped kxk Conv, owns its weight and has input channels esp-dl's
    S3 kernels cannot take sixteen at a time, but output channels they can.
    """
    from esp_ppq.IR.quantize import QuantableOperation

    if not isinstance(op, QuantableOperation) or op.type != "Conv" or len(op.inputs) < 2:
        return False
    weight = op.inputs[1]
    if not weight.is_parameter or weight.value.dim() != 4 or len(weight.dest_ops) != 1:
        return False
    outputs, channels, *kernel = weight.value.shape
    return (
        op.attributes.get("group", 1) == 1
        and channels % CHANNEL_STEP != 0
        and outputs % CHANNEL_STEP == 0
        and kernel != [1, 1]
        and all(d == 1 for d in op.attributes.get("dilations", [1]))
        and per_tensor(op)
        and int8([*op.input_quant_config[:2], *op.output_quant_config])
    )


def im2col_from(graph, op) -> bool:
    """op's weight laid out by patch_weight when op is im2col_ready; export_graph renames op."""
    if not im2col_ready(op):
        return False
    op.inputs[1].value = patch_weight(op.inputs[1].value)
    op.attributes[IM2COL_MARK] = True
    return True


@contextlib.contextmanager
def im2col_convolutions() -> Iterator[None]:
    """Each convolution over too few input channels run by esp-dl's aligned 1x1 kernel on patches.

    An RGB stem's 3 channels send esp-dl down its unaligned path (latency.md 14.2). ConvIm2col
    gathers each output pixel's patch into channels, so every sum keeps its products plus zeros.
    """
    from esp_ppq.parser import espdl_exporter

    prepare = espdl_exporter.EspdlExporter.prepare_graph
    write = espdl_exporter.EspdlExporter.export_graph

    def rewriting(self, graph, *args, **kwargs):
        for op in list(graph.topological_sort()):
            im2col_from(graph, op)
        return prepare(self, graph, *args, **kwargs)

    def writing(self, graph, *args, **kwargs):
        for op in graph.operations.values():
            if op.attributes.pop(IM2COL_MARK, False):
                op.type = IM2COL_CONV
        return write(self, graph, *args, **kwargs)

    espdl_exporter.EspdlExporter.prepare_graph = rewriting
    espdl_exporter.EspdlExporter.export_graph = writing
    try:
        yield
    finally:
        espdl_exporter.EspdlExporter.prepare_graph = prepare
        espdl_exporter.EspdlExporter.export_graph = write


def gated(graph, add) -> tuple | None:
    """add's Mul, x, gate and residual when a prepared graph can run the pair as MulAdd: an int8
    per-tensor Mul of a [1, H, W, C] map by a [1, 1, 1, C] gate as the chip lays them, read by add
    alone, with the product, the residual and add on one grid.
    """
    from esp_ppq.IR.quantize import QuantableOperation
    from esp_ppq.parser.espdl.espdl_typedef import ExporterPatternInfo

    if add.type != "Add" or not isinstance(add, QuantableOperation) or len(add.inputs) != 2:
        return None
    info = ExporterPatternInfo()
    for index in (0, 1):
        product, residual = add.inputs[index], add.inputs[1 - index]
        mul = product.source_op
        if not isinstance(mul, QuantableOperation) or mul.type != "Mul" or len(mul.inputs) != 2:
            continue
        x_shape = laid_shape(product, info)
        x, gate = mul.inputs if laid_shape(mul.inputs[0], info) == x_shape else mul.inputs[::-1]
        gate_shape = laid_shape(gate, info)
        if (
            product.dest_ops != [add]
            or product.name in graph.outputs
            or residual in (product, x, gate)
            or len(x_shape) != 4
            or x_shape[-1] % CHANNEL_STEP
            or gate_shape != [1, 1, 1, x_shape[-1]]
            or laid_shape(residual, info) != x_shape
            or not (per_tensor(mul) and per_tensor(add))
            or not int8([*mul.input_quant_config, *add.input_quant_config])
            or not int8(add.output_quant_config)
        ):
            continue
        grid = [mul.output_quant_config[0], *add.input_quant_config, add.output_quant_config[0]]
        if one_grid(*grid):
            return mul, x, gate, residual
    return None


def mul_add_from(graph, add) -> bool:
    """add and its gated Mul replaced by one MulAdd reading x, the gate and the residual."""
    from esp_ppq.core import OperationQuantizationConfig

    found = gated(graph, add)
    if found is None:
        return False
    mul, x, gate, residual = found
    product = mul.outputs[0]
    configs = [
        mul.input_quant_config[mul.inputs.index(x)],
        mul.input_quant_config[mul.inputs.index(gate)],
        add.input_quant_config[add.inputs.index(residual)],
    ]
    graph.remove_operation(mul)
    for var in add.inputs:
        var.dest_ops.remove(add)
    add.inputs.clear()
    graph.remove_variable(product)
    for var in (x, gate, residual):
        add.inputs.append(var)
        var.dest_ops.append(add)
    add.config = OperationQuantizationConfig(configs, add.output_quant_config)
    add.type = MUL_ADD
    return True


@contextlib.contextmanager
def mul_add() -> Iterator[None]:
    """Each gated residual exported as one MulAdd, its product never written out (KEHOACH 3.7).

    The pairs are joined once the layout, requantisation and exponents are settled, so MulAdd reads
    the very tensors and grids esp-dl's Mul and Add would.
    """
    from esp_ppq.parser import espdl_exporter

    prepare = espdl_exporter.EspdlExporter.prepare_graph

    def joining(self, graph, *args, **kwargs):
        graph = prepare(self, graph, *args, **kwargs)
        for op in list(graph.topological_sort()):
            if op.name in graph.operations:
                mul_add_from(graph, op)
        return graph

    espdl_exporter.EspdlExporter.prepare_graph = joining
    try:
        yield
    finally:
        espdl_exporter.EspdlExporter.prepare_graph = prepare


def relu_ready(clip) -> bool:
    """clip, a Clip from 0 that a Relu fused into its Conv can stand for: an int8 Conv's lone
    reader, the Conv's output grid kept through it.
    """
    from esp_ppq.IR.quantize import QuantableOperation

    if clip.type != "Clip" or not isinstance(clip, QuantableOperation):
        return False
    conv = clip.inputs[0].source_op
    if not isinstance(conv, QuantableOperation) or conv.type != "Conv":
        return False
    grid = [conv.output_quant_config[0], clip.input_quant_config[0], clip.output_quant_config[0]]
    return (
        clip_bounds(clip)[0] == 0
        and len(clip.inputs[0].dest_ops) == 1
        and int8([*conv.input_quant_config[:2], *grid])
        and one_grid(*grid)
    )


def chip_clip(op, values: list, ctx=None, **kwargs):
    """ESP-PPQ's Clip; a relu_ready one is left to its grid's int8 top, as the fused Relu is."""
    from esp_ppq.core import QuantizationStates
    from esp_ppq.executor.op.torch.default import Clip_forward

    if QuantizationStates.is_activated(op.output_quant_config[0].state) and relu_ready(op):
        return torch.relu(values[0])
    return Clip_forward(op, values, ctx, **kwargs)


def relu_from_clip(graph, conv) -> bool:
    """conv's lone reader, a relu_ready Clip, turned into the Relu ESP-PPQ fuses into conv."""
    from esp_ppq.core import OperationQuantizationConfig

    readers = graph.get_downstream_operations(conv) if conv.name in graph.operations else []
    if conv.type != "Conv" or len(readers) != 1 or not relu_ready(readers[0]):
        return False
    if conv.outputs[0].name in graph.outputs:
        raise ValueError(
            f"{conv.name} writes a graph output, so the Clip simulated on it stays apart"
        )
    clip = readers[0]
    for bound in clip.inputs[1:]:
        bound.dest_ops.remove(clip)
        if not bound.dest_ops:
            graph.remove_variable(bound)
    del clip.inputs[1:]
    clip.config = OperationQuantizationConfig(clip.input_quant_config[:1], clip.output_quant_config)
    clip.type = "Relu"
    return True


@contextlib.contextmanager
def clip_as_relu() -> Iterator[None]:
    """Each relu_ready Clip simulated with no upper bound and exported as a Relu inside its Conv.

    esp-dl fuses no bounded activation into a convolution, so a ReLU6 runs alone as a table lookup
    that reads and writes its tensor again (KEHOACH 3.7).
    """
    from esp_ppq.core import TargetPlatform
    from esp_ppq.executor.base import OPERATION_FORWARD_TABLE
    from esp_ppq.parser.espdl import export_patterns

    table = OPERATION_FORWARD_TABLE[TargetPlatform.ESPDL_S3_INT8]
    simulated = table["Clip"]
    joined = export_patterns.FuseReluLikePattern.export

    def joining(self, op, graph, **kwargs):
        relu_from_clip(graph, op)
        return joined(self, op, graph, **kwargs)

    table["Clip"] = chip_clip
    export_patterns.FuseReluLikePattern.export = joining
    try:
        yield
    finally:
        table["Clip"] = simulated
        export_patterns.FuseReluLikePattern.export = joined


PRELU_MARK = "PRelu"


def one_grid(*configs) -> bool:
    """Every config quantises on the same per-tensor grid."""
    return len({float(config.scale) for config in configs}) == 1


def int8(configs) -> bool:
    return all(config.num_of_bits == 8 for config in configs)


def prelu_grid(prelu) -> list:
    """The configs a fused PRelu needs on one grid: its Conv's output, its own input and output."""
    conv = prelu.inputs[0].source_op
    return [conv.output_quant_config[0], prelu.input_quant_config[0], prelu.output_quant_config[0]]


def joinable(prelu) -> bool:
    """prelu, a PRelu, has all fusable asks but the one grid: a 2-D int8 Conv's lone reader with an
    int8 slope a channel on a fractional grid.
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
    slope_config = prelu.input_quant_config[1]
    return (
        int8([*conv.input_quant_config[:2], *prelu_grid(prelu), slope_config])
        and float(slope_config.scale) < 1
    )


def fusable(prelu) -> bool:
    """prelu, a PRelu, applied by esp-dl's S3 kernels where its 2-D Conv rounds: joinable, and the
    Conv's output grid kept throughout.
    """
    return joinable(prelu) and one_grid(*prelu_grid(prelu))


def share_prelu_grids(graph) -> int:
    """Each joinable PRelu off its Conv's grid moved onto it, then every passive parameter derived
    again as ESP-PPQ does when it quantises; returns how many moved.
    """
    from esp_ppq.quantization.optim import PassiveParameterQuantizePass

    moved = 0
    for op in graph.operations.values():
        if op.type != "PRelu" or not joinable(op) or fusable(op):
            continue
        conv_out, _given, out = prelu_grid(op)
        if out.is_revisable():
            out.scale = conv_out.scale.clone()
            moved += 1
    if moved:
        PassiveParameterQuantizePass().optimize(graph=graph)
    return moved


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
            fused = op.attributes.get("activation") == PRELU_MARK
            claimed = SLICES_MARK in op.attributes or IM2COL_MARK in op.attributes
            if op.type == "Conv" and fused and not claimed:
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
    "channel_conv": channel_conv,
    "im2col_convolutions": im2col_convolutions,
    "mul_add": mul_add,
    "clip_as_relu": clip_as_relu,
    "prelu_on_input_grid": contextlib.nullcontext,
}
# Patches that change an integer the chip computes: ladder variants only (KEHOACH 3.7).
ROUNDING = frozenset({"fused_prelu", "clip_as_relu", "prelu_on_input_grid"})
# Rounding patches that rewrite the quantised graph once, when their ladder row is built.
REWRITES: dict[str, Callable] = {"prelu_on_input_grid": share_prelu_grids}
# The rounding patch each of these has to stack on in rounding_patches.
STACKS_ON = {"prelu_on_input_grid": "fused_prelu"}


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
