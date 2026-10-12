"""The board probe of KEHOACH 3.7: a ladder row's graph, cuts through it, and real frames.

<run>/int8/<row>/probe/ gets the graph and its cuts as .espdl, each with one real frame as its
model->test() pair, packed into models images. test_apps/probe/main/probe/ gets the frames.gold the
app embeds, real inputs with the whole graph's simulated int8 outputs, and the manifest make reads.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

from ... import REPO_ROOT, tasks
from ...export import emit_golden, pack_models_partition
from . import esp_ppq_patches, export_espdl, ladder, ptq_espdl

PROBE_APP = REPO_ROOT / "firmware" / "components" / "ai_engine" / "test_apps" / "probe"
RECORD = PROBE_APP / "main" / "probe" / "frames.gold"
MANIFEST = RECORD.with_name("manifest.json")
PARTITIONS = REPO_ROOT / "firmware" / "partitions.dev.csv"


def ancestors(op) -> set[str]:
    """The names of op and of every op it reads from."""
    needed, stack = set(), [op]
    while stack:
        top = stack.pop()
        if top is not None and top.name not in needed:
            needed.add(top.name)
            stack.extend(v.source_op for v in top.inputs)
    return needed


def truncated(graph, name: str):
    """A copy of graph that computes only the variable name, made its one output."""
    cut = graph.copy()
    needed = ancestors(cut.variables[name].source_op)
    for op in [op for op in cut.operations.values() if op.name not in needed]:
        cut.remove_operation(op, remove_unlinked_variable=True)
    cut.outputs.clear()
    cut.mark_variable_as_graph_output(cut.variables[name])
    return cut


def cut_points(graph, count: int, span: tuple[int, int] | None = None) -> list[tuple[int, str]]:
    """count (topological index, variable) pairs spread evenly inside span of the graph's ops.

    Each is the int8 output of a quantised op, not a graph output, whose cut keeps the owner of
    every config the kept ops follow: a config dominated from a dropped op cannot be exported.
    """
    from esp_ppq.core import QuantizationStates
    from esp_ppq.IR.quantize import QuantableOperation

    ops = graph.topological_sort()
    first, last = span or (0, len(ops))
    owner = {}
    for op in ops:
        if isinstance(op, QuantableOperation):
            for config in [*op.input_quant_config, *op.output_quant_config]:
                owner.setdefault(id(config), op.name)

    def cuttable(op) -> bool:
        if not isinstance(op, QuantableOperation) or op.outputs[0].name in graph.outputs:
            return False
        if not QuantizationStates.is_activated(op.output_quant_config[0].dominated_by.state):
            return False
        kept = ancestors(op)
        quantable = [graph.operations[name] for name in kept]
        configs = [
            c
            for kept_op in quantable
            if isinstance(kept_op, QuantableOperation)
            for c in [*kept_op.input_quant_config, *kept_op.output_quant_config]
        ]
        return all(owner.get(id(c.dominated_by), op.name) in kept for c in configs)

    picks = []
    for k in range(1, count + 1):
        i = first + (last - first) * k // (count + 1)
        while i < last and not cuttable(ops[i]):
            i += 1
        if i < last and (not picks or picks[-1][0] != i):
            picks.append((i, ops[i].outputs[0].name))
    return picks


def laid(y: np.ndarray) -> np.ndarray:
    """One sample of a channels-first tensor in esp-dl's channels-last layout."""
    sample = y[0]
    return np.ascontiguousarray(np.moveaxis(sample, 0, -1) if sample.ndim >= 2 else sample)


def frames_record(graph, xs: np.ndarray, patches: list[str]) -> dict[str, np.ndarray]:
    """Each frame's int8 input and simulated int8 outputs, channels last, and each port's exponent.

    Refused when a simulated output is off its int8 grid.
    """
    (port, *_), outputs = ptq_espdl.ports_of(graph)
    simulator = ptq_espdl.Simulator(graph, patches, device="cpu")
    record = {"in_exp": np.array([port.exponent], np.int32)}
    for out in outputs:
        record[f"exp.{out.name}"] = np.array([out.exponent], np.int32)
    for i, x in enumerate(xs):
        record[f"x{i}"] = laid(ptq_espdl.to_int8(x[None], port.exponent))
        for out, y in zip(outputs, simulator(x[None]), strict=True):
            y_int8 = ptq_espdl.to_int8(y, out.exponent)
            if not np.array_equal(y_int8.astype(np.float32) * np.float32(2.0**out.exponent), y):
                raise ValueError(f"frame {i}: the simulated {out.name} is off its int8 grid")
            record[f"y{i}.{out.name}"] = laid(y_int8)
    return record


def image_of(entries: list[tuple[str, Path]], hw: tuple[int, int], built_at: int) -> bytes:
    """One models image holding entries, laid out as pack_models_partition lays out a release."""
    models = [
        pack_models_partition.Model(
            branch=name, entry_name=name, path=path, sha256=pack_models_partition.sha256_of(path),
            in_h=hw[0], in_w=hw[1], arena_hint=0,
        )
        for name, path in entries
    ]  # fmt: skip
    return pack_models_partition.build_image(models, built_at)


def packed(
    entries: list[tuple[str, Path]], hw: tuple[int, int], capacity: int, out: Path
) -> list[Path]:
    """entries as models images in the order given, each as full as header and capacity allow."""
    built_at = int(time.time())
    groups: list[list[tuple[str, Path]]] = []
    for entry in entries:
        grown = [*groups[-1], entry] if groups else []
        fits = len(grown) <= pack_models_partition.ENTRY_SLOTS
        if groups and fits and len(image_of(grown, hw, built_at)) <= capacity:
            groups[-1] = grown
        else:
            groups.append([entry])
    images = []
    for j, group in enumerate(groups):
        image = image_of(group, hw, built_at)
        if len(image) > capacity:
            raise ValueError(f"{group[0][0]} takes {len(image)} B, a model slot holds {capacity} B")
        path = out / f"models_{j}.bin"
        path.write_bytes(image)
        images.append(path)
    return images


def probe(run: Path, row: str, span: tuple[int, int] | None = None) -> Path:
    """Write the probe of the run's row and return the manifest make ai-unit reads."""
    branch = tasks.branch_of(run)
    knobs = ptq_espdl.block(branch)
    patches = ladder.row_patches(run, row)
    entry = pack_models_partition.BRANCH_ENTRY[branch]
    folder = ladder.row_dir(run, row)
    out = folder / "probe"
    out.mkdir(parents=True, exist_ok=True)
    graph = export_espdl.load_native(folder / ladder.GRAPH_FILE)
    xs = ladder.real_inputs(run, graph, knobs["probe"]["frames"])
    emit_golden.write_case(RECORD, frames_record(graph, xs, patches))
    with esp_ppq_patches.applied(patches):
        entries = [(entry, export_espdl.export(graph, out / f"{entry}.espdl", xs[:1]))]
        for k, (index, name) in enumerate(cut_points(graph, knobs["probe"]["cuts"], span)):
            part = export_espdl.export(truncated(graph, name), out / f"{entry}_c{k}.espdl", xs[:1])
            entries.append((f"{entry}_c{k}", part))
            print(f"{entry}_c{k}: op {index}, {name}, {part.stat().st_size} bytes of .espdl")
    height, width = (int(v) for v in ladder.config_of(run).model.input_hw)
    capacity = pack_models_partition.partition_size(PARTITIONS, "models_0")
    images = packed(entries, (height, width), capacity, out)
    logs = [image.with_suffix(".log") for image in images]
    manifest = {
        "branch": branch,
        "row": row,
        "entries": [name for name, _ in entries],
        "images": [str(image) for image in images],
        "logs": [str(log) for log in logs],
        "whole_espdl": str(entries[0][1]),
        "whole_log": str(logs[0]),
        "frames": len(xs),
        "record": str(RECORD),
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"{len(entries)} graphs in {len(images)} images, {len(xs)} frames: {MANIFEST}")
    return MANIFEST


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--row", required=True)
    parser.add_argument("--cut-range", type=int, nargs=2, metavar=("FIRST", "LAST"))
    args = parser.parse_args(argv)
    probe(args.run.resolve(), args.row, tuple(args.cut_range) if args.cut_range else None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
