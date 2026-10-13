"""Step 2.2 of KEHOACH 3.7: esp-dl's per-module profile from a board log, joined to its .espdl.

Each module's time is ranked, and each slow path of esp-dl's S3 kernels is tagged with the patch of
esp_ppq_patches that handles it, or with the rewrite it asks for when no patch does. The CPU clock
and data cache are the firmware's own, read from its sdkconfig defaults.
"""

from __future__ import annotations

import argparse
import math
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from ... import REPO_ROOT
from . import espdl_shapes

SDKCONFIG = REPO_ROOT / "firmware" / "sdkconfig.defaults.esp32s3"
CHANNEL_STEP = 16  # esp-dl's S3 vector kernels take channels sixteen at a time
MATMUL_STEP = 16  # dl_base_matmul.cpp: vector path, 16 output columns
LAYOUT_OPS = frozenset({"Transpose"})
GRID_OPS = frozenset({"QuantizeLinear", "RequantizeLinear", "DequantizeLinear"})
FLOAT_KERNEL_OPS = frozenset({"LayerNormalization", "Softmax"})
# ESP-PPQ fuses only Relu into a convolution; esp-dl 3.3's activation_type_t has no ReLU6.
LUT_MARK = "lut = "
UNFUSED_ACTIVATIONS = frozenset({"PRelu", "LeakyRelu"})
# Readers padded_channels can carry zero channels through or into: per channel ops and convolutions.
PADDABLE_READERS = frozenset({"Conv", "ConvPRelu", "PRelu", "Relu", "LeakyRelu", "Clip"})
PROFILE_ROW = re.compile(r"\|\s*(?P<name>\S+)\s*\|\s*(?P<op>\w+)\s*\|\s*(?P<us>\d+)us\s*\|")
# esp-dl's profile_memory leaves a cell blank when it holds 0.00KB.
MEMORY_TOTAL = re.compile(r"\|\s*total\s*\|" + r"\s*(?:([0-9.]+)KB)?\s*\|" * 3)
VALUE_INFO = re.compile(
    r"^%(?P<name>[^\[\s]+)\[(?P<dtype>[A-Z0-9]+), (?P<shape>[0-9x]*)\]", re.MULTILINE
)
CPU_MHZ_KEY = re.compile(r"^CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_(\d+)=y$", re.MULTILINE)
DATA_CACHE_KEY = re.compile(r"^CONFIG_ESP32S3_DATA_CACHE_(\d+)KB=y$", re.MULTILINE)


@dataclass
class Module:
    """One profiled module: its op, time on the chip, and the .info's view of its variables."""

    name: str
    op: str
    us: int
    inputs: list[str]
    outputs: list[str]
    attrs: str


def chip(sdkconfig: Path = SDKCONFIG) -> tuple[int, int]:
    """The firmware's CPU clock in MHz and data cache in bytes."""
    text = sdkconfig.read_text(encoding="utf-8")
    mhz, cache = CPU_MHZ_KEY.search(text), DATA_CACHE_KEY.search(text)
    if mhz is None or cache is None:
        raise ValueError(f"{sdkconfig}: no CPU clock or data cache size to profile against")
    return int(mhz.group(1)), int(cache.group(1)) * 1024


def profile(text: str, graph: dict | None = None) -> dict[str, tuple[str, int]]:
    """Each module's (op, µs) in the last profile_module print in text.

    With graph, from nodes(), only rows naming one of its nodes with that node's op count: a serial
    line can drop a row's characters, and what is left of a name may be another node's.
    """
    rows = ((m["name"], m["op"], int(m["us"])) for m in PROFILE_ROW.finditer(text))
    return {
        name: (op, us) for name, op, us in rows if graph is None or graph.get(name, ("",))[0] == op
    }


def memory(text: str) -> dict[str, float] | None:
    """The model's KB in internal RAM, PSRAM and flash, from the last profile_memory print."""
    found = MEMORY_TOTAL.findall(text)
    if not found:
        return None
    return dict(
        zip(("internal", "psram", "flash"), (float(v or 0) for v in found[-1]), strict=True)
    )


def nodes(espdl: Path) -> dict[str, tuple[str, list[str], list[str]]]:
    """Each node of an .espdl by name: (op, inputs, outputs)."""
    from esp_ppq.parser.espdl.FlatBuffers.Dl import Model

    graph = Model.Model.GetRootAs(espdl.read_bytes()[16:], 0).Graph()
    found = {}
    for i in range(graph.NodeLength()):
        node = graph.Node(i)
        found[node.Name().decode()] = (
            node.OpType().decode(),
            [node.Input(j).decode() for j in range(node.InputLength())],
            [node.Output(j).decode() for j in range(node.OutputLength())],
        )
    return found


def shapes(info_text: str, info: espdl_shapes.Info) -> dict[str, list[int]]:
    """Every variable's shape as the chip lays it: the .info's value infos, inputs, initializers."""
    found = {m["name"]: espdl_shapes.dims(m["shape"], "x") for m in VALUE_INFO.finditer(info_text)}
    return found | info.inputs | info.declared


def column_merge(x: list[int], y: list[int], attrs: str, cache_bytes: int) -> int | None:
    """How many columns aligned_pointwise lays as channels to align a convolution, or None.

    The kernel must span s columns at a stride of s and one of all else; the k columns then merged
    must align both channel counts with block-diagonal weights inside the data cache.
    """
    kernel = espdl_shapes.attribute(attrs, "kernel_shape", [])
    if not kernel:
        return None
    s, rest = kernel[-1], [*kernel[:-1], *espdl_shapes.attribute(attrs, "dilations", [])]
    strides = espdl_shapes.attribute(attrs, "strides", [1] * len(kernel))
    group, (c_in, c_out) = espdl_shapes.attribute(attrs, "group", 1), (x[-1], y[-1])
    if strides != [1] * (len(kernel) - 1) + [s] or any(v != 1 for v in rest):
        return None
    if any(espdl_shapes.attribute(attrs, "pads", [])) or x[-2] != s * y[-2]:
        return None
    if group != 1 and (group != c_in or c_in != c_out or s != 1):
        return None
    for k in (1, 2, 4, 8, CHANNEL_STEP):
        if y[-2] % k == 0 and not (k * s * c_in % CHANNEL_STEP or k * c_out % CHANNEL_STEP):
            weight_bytes = k * c_out * (1 if group != 1 else k * s * c_in)
            return k if weight_bytes <= cache_bytes else None
    return None


def unaligned_fix(
    module: Module, x: list[int], y: list[int], readers: dict, cache_bytes: int
) -> str:
    """The patch that aligns module's channels to 16, or why none does."""
    out_readers = readers.get(module.outputs[0], [])
    if y[-1] % CHANNEL_STEP and out_readers and set(out_readers) <= PADDABLE_READERS:
        return "padded_channels"
    if x[-1] % CHANNEL_STEP and x[-1] != 3 and not y[-1] % CHANNEL_STEP:
        return "padded_channels, from the convolution that makes them"
    kernel = espdl_shapes.attribute(module.attrs, "kernel_shape", [1])
    group = espdl_shapes.attribute(module.attrs, "group", 1)
    if x[-1] % CHANNEL_STEP and not y[-1] % CHANNEL_STEP and group == 1 and set(kernel) != {1}:
        return "im2col_convolutions"
    k = column_merge(x, y, module.attrs, cache_bytes)
    return f"aligned_pointwise, {k} columns" if k else "no export patch"


def conv_tags(
    module: Module, laid: dict[str, list[int]], cpu_mhz: int, cache_bytes: int, readers=None
):
    """A convolution's slow paths and its cycles a multiply-add, None when shapes are unknown."""
    x, w, y = (laid.get(name) for name in (*module.inputs[:2], module.outputs[0]))
    if x is None or w is None or y is None:
        return [], None
    group = espdl_shapes.attribute(module.attrs, "group", 1)
    taps = math.prod(w[:-2])
    c_in, c_out = (w[-2], y[-1]) if module.op == espdl_shapes.IM2COL_CONV else (x[-1], y[-1])
    macs = math.prod(y) * (c_in // group) * taps
    tags = []
    if c_in % CHANNEL_STEP or c_out % CHANNEL_STEP:
        fix = unaligned_fix(module, x, y, readers or {}, cache_bytes)
        tags.append(f"unaligned {c_in} -> {c_out} channels ({fix})")
    weight_bytes = math.prod(w)
    pointwise_rows = group == 1 and taps == 1 and math.prod(y[:-1]) > 1
    if pointwise_rows and weight_bytes >= cache_bytes and not c_out % CHANNEL_STEP:
        tags.append(
            f"{weight_bytes // 1024} KB of weights fill the cache (cache_sized_convolutions)"
        )
    return tags, module.us * cpu_mhz / max(macs, 1)


def banded_rate(module: Module, laid: dict[str, list[int]], cpu_mhz: int) -> float | None:
    """A PointwiseDepthwise's cycles a multiply-add over all its convolutions."""
    x, w, y = (laid.get(name) for name in (*module.inputs[:2], module.outputs[0]))
    if x is None or w is None or y is None:
        return None
    kernel = espdl_shapes.attribute(module.attrs, "kernel_shape", [1, 1])
    pool = espdl_shapes.attribute(module.attrs, "max_pool", [1, 1])
    middle, spots = w[-1], math.prod(y[:-1]) * math.prod(pool)
    macs = math.prod(x) * middle + spots * middle * math.prod(kernel)
    if espdl_shapes.attribute(module.attrs, "project_inputs", 0):
        macs += spots * middle * y[-1]
    return module.us * cpu_mhz / max(macs, 1)


def tags_of(module: Module, laid: dict, readers: dict, cpu_mhz: int, cache_bytes: int):
    """The slow paths module takes on esp-dl's S3 kernels, each with the patch that handles it.

    A convolution also returns its cycles a multiply-add.
    """
    if module.op in espdl_shapes.CONV_OPS:
        return conv_tags(module, laid, cpu_mhz, cache_bytes, readers)
    if module.op == espdl_shapes.POINTWISE_DEPTHWISE:
        return [], banded_rate(module, laid, cpu_mhz)
    tags = []
    if "quant_type = 'F32'" in module.attrs:
        tags.append("runs in float")
    if module.op in FLOAT_KERNEL_OPS:
        tags.append("esp-dl's int8 kernel works in float32 per value (no export patch)")
    if LUT_MARK in module.attrs and module.op == "Clip":
        tags.append(
            "activation alone, one table lookup a value (clip_as_relu, from 0 after a Conv)"
        )
    elif LUT_MARK in module.attrs:
        tags.append("activation alone, one table lookup a value (no export patch)")
    if module.op == "PRelu":
        tags.append("activation alone (fused_prelu, when its Conv alone feeds it on one grid)")
    elif module.op in UNFUSED_ACTIVATIONS:
        tags.append("activation alone, ESP-PPQ fuses only Relu (no export patch)")
    if module.op == "MatMul" and (y := laid.get(module.outputs[0])) and y[-1] < MATMUL_STEP:
        tags.append(f"{y[-1]} output columns run in C (lay the product transposed)")
    if module.op in LAYOUT_OPS:
        tags.append("layout copy (lean_transposes)")
    if module.op in GRID_OPS:
        tags.append("grid change (lean_quantizers when repeated)")
    if (
        module.op == "Concat"
        and len(set(module.inputs)) == 1
        and readers.get(module.outputs[0]) == ["Transpose"]
    ):
        tags.append("copies of one map (copies_by_broadcast)")
    return tags, None


def kernel_class(module: Module, laid: dict[str, list[int]]) -> str:
    """The esp-dl kernel family module runs on, the unit the inventory sums time by."""
    if module.op == espdl_shapes.POINTWISE_DEPTHWISE:
        kernel = "x".join(str(k) for k in espdl_shapes.attribute(module.attrs, "kernel_shape", [1]))
        stride = espdl_shapes.attribute(module.attrs, "strides", [1])[0]
        tail = " + pointwise" if espdl_shapes.attribute(module.attrs, "project_inputs", 0) else ""
        if espdl_shapes.attribute(module.attrs, "max_pool", None):
            tail = " + max pool"
        return f"pointwise + depthwise {kernel} s{stride}{tail} in bands"
    if module.op not in espdl_shapes.CONV_OPS:
        return f"{module.op} (table lookup)" if LUT_MARK in module.attrs else module.op
    x, y = laid.get(module.inputs[0]), laid.get(module.outputs[0])
    if x is None or y is None:
        return "convolution, shapes unknown"
    kernel = espdl_shapes.attribute(module.attrs, "kernel_shape", [1])
    stride = espdl_shapes.attribute(module.attrs, "strides", [1])[0]
    group = espdl_shapes.attribute(module.attrs, "group", 1)
    aligned = "unaligned" if x[-1] % CHANNEL_STEP or y[-1] % CHANNEL_STEP else "aligned"
    size = "x".join(str(k) for k in kernel)
    if module.op == espdl_shapes.IM2COL_CONV:
        return f"convolution {size} s{stride} over gathered patches"
    if x[-1] == 3:
        return f"convolution {size} s{stride} from 3 channels"
    if group > 1 and group == x[-1]:
        return f"depthwise {size} s{stride} {aligned}"
    if group == 1 and all(k == 1 for k in kernel):
        return f"pointwise {aligned}"
    return f"convolution {size} s{stride} {aligned}"


def classes(
    entries: list[tuple[str, int, float | None]],
) -> list[tuple[str, int, int, list, float]]:
    """Per kernel class: modules, microseconds, cycle rates, and microseconds at its best rate.

    entries are (class, us, cycles a MAC or None); a module without a rate keeps its own time.
    """
    grouped = defaultdict(list)
    for name, us, rate in entries:
        grouped[name].append((us, rate))
    found = []
    for name, members in grouped.items():
        rates = sorted(rate for _, rate in members if rate is not None)
        best = rates[0] if rates else None
        floor = sum(us * best / rate if rate else us for us, rate in members) if best else None
        total = sum(us for us, _ in members)
        found.append((name, len(members), total, rates, total if floor is None else floor))
    return sorted(found, key=lambda row: -row[2])


def report(log_text: str, espdl: Path, top: int, every: bool = False) -> str:
    """The profile in log_text of espdl: time by op type, then the slowest modules, tagged.

    every adds each module and the kernel classes with what reaching their best rate would save.
    """
    cpu_mhz, cache_bytes = chip()
    info_text = espdl.with_suffix(".info").read_text(encoding="utf-8")
    graph, info = nodes(espdl), espdl_shapes.parse(info_text)
    timed, rows = profile(log_text, graph), len(PROFILE_ROW.findall(log_text))
    laid = shapes(info_text, info)
    attrs = {outs[0]: a for _, a, _, outs in info.nodes}
    readers = defaultdict(list)
    for op, ins, _ in graph.values():
        for name in ins:
            readers[name].append(op)
    modules = [
        Module(name, op, us, graph[name][1], graph[name][2], attrs.get(graph[name][2][0], ""))
        for name, (op, us) in timed.items()
    ]
    by_op = defaultdict(lambda: [0, 0])
    for m in modules:
        by_op[m.op][0] += 1
        by_op[m.op][1] += m.us
    lines = [
        f"{sum(m.us for m in modules) / 1000:.1f} ms over {len(modules)} modules of {espdl.name}"
    ]
    if rows > len(modules):
        lines.append(
            f"{rows - len(modules)} rows of the log left out: another model's, garbled, or a total"
        )
    held = memory(log_text)
    if held is not None:
        lines.append("memory: " + ", ".join(f"{place} {kb:.1f} KB" for place, kb in held.items()))
    lines.append("by op type:")
    ranked_ops = sorted(by_op.items(), key=lambda kv: -kv[1][1])
    lines += [f"  {op:22s} {n:4d} {us / 1000:8.1f} ms" for op, (n, us) in ranked_ops]
    ranked = sorted(modules, key=lambda m: -m.us)
    tagged = {m.name: tags_of(m, laid, readers, cpu_mhz, cache_bytes) for m in ranked}
    lines.append(f"{'every' if every else f'slowest {top}'} modules:")
    for m in ranked if every else ranked[:top]:
        tags, rate = tagged[m.name]
        cycles = f"{rate:5.2f} c/MAC " if rate is not None else ""
        lines.append(
            f"  {m.us / 1000:7.1f} ms {m.op:18s} {cycles}{m.name}"
            + "".join(f"\n      - {t}" for t in tags)
        )
    if every:
        total = max(sum(m.us for m in modules), 1)
        entries = [(kernel_class(m, laid), m.us, tagged[m.name][1]) for m in modules]
        lines.append("by kernel class, with the time saved at the class's fastest module's rate:")
        for name, count, us, rates, floor in classes(entries):
            line = f"  {us / 1000:7.1f} ms {100 * us / total:5.1f}% x{count:<3d} {name}"
            if rates:
                line += f"  c/MAC {rates[0]:.2f} / {rates[len(rates) // 2]:.2f} / {rates[-1]:.2f}"
            if us - floor >= 50:
                line += f"  saves {(us - floor) / 1000:.1f} ms"
            lines.append(line)
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--espdl", type=Path, required=True)
    parser.add_argument("--top", type=int, default=40)
    parser.add_argument("--all", action="store_true", help="every module and the kernel classes")
    args = parser.parse_args(argv)
    log_text = args.log.read_text(encoding="utf-8", errors="replace")
    print(report(log_text, args.espdl, args.top, args.all))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
