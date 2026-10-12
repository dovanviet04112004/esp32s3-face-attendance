"""The ESP-DL ladder of KEHOACH 3.7 for one run: rows scored with the branch's ruler beside Q0.

Each row keeps its native graph and .espdl in <run>/int8/<row>/ and one entry in
<run>/int8/ladder.yaml. Rung 4 trains, so it runs only with the owner's go.
"""

from __future__ import annotations

import argparse
import functools
import re
import tempfile
from pathlib import Path

import numpy as np
import torch
import yaml

from ... import ML_ROOT, REPO_ROOT, tasks
from ...export import espdl_op_check, update_lock
from . import esp_ppq_patches, export_espdl, mixed_espdl, ptq_espdl, qat_espdl

PATHS = ML_ROOT / "configs" / "common" / "paths.yaml"
DEVICE_SPLIT = ML_ROOT / "data" / "splits" / "device" / "v1" / "test_device.txt"
INT8_DIR, LADDER_FILE, GRAPH_FILE = "int8", "ladder.yaml", "graph.native"
CEILING_ROW = "float"
FRAME_TIME = re.compile(r"(\d+) us mean")


def paths_entry(entry: str):
    node = yaml.safe_load(PATHS.read_text(encoding="utf-8"))
    for key in entry.split("."):
        node = node[key]
    return node


def data_path(entry: str) -> Path:
    """One dataset root of configs/common/paths.yaml, resolved against ml/."""
    return ML_ROOT / paths_entry(entry)


def data_paths(entry: str) -> dict[str, Path]:
    """A mapping of configs/common/paths.yaml, each root resolved against ml/."""
    return {name: ML_ROOT / root for name, root in paths_entry(entry).items()}


def firmware_constant(relative: str, pattern: re.Pattern) -> float:
    """A number the firmware declares, read from its source rather than copied (KEHOACH 4.9)."""
    found = pattern.search((REPO_ROOT / relative).read_text(encoding="utf-8"))
    if found is None:
        raise ValueError(f"{relative}: the constant this step depends on is gone")
    return float(found.group(1))


@functools.cache
def device_frames() -> tuple[tuple[str, int, np.ndarray], ...]:
    """Every frame of test_device as (name, label, RGB), in the split's order."""
    from PIL import Image

    raw = data_path("device.ov5640")
    frames = []
    for line in DEVICE_SPLIT.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        name, label = line.split()
        with Image.open(raw / name) as handle:
            frames.append((name, int(label), np.array(handle.convert("RGB"), dtype=np.uint8)))
    return tuple(frames)


class TorchRunner:
    """The float model as a runner: float NCHW in, outputs in the ONNX graph's order out."""

    batched = True

    def __init__(self, model: torch.nn.Module) -> None:
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = model.eval().to(self.device)

    def __call__(self, x: np.ndarray) -> list[np.ndarray]:
        tensor = torch.from_numpy(np.ascontiguousarray(x, dtype=np.float32)).to(self.device)
        with torch.no_grad():
            out = self.model(tensor)
        outs = out if isinstance(out, tuple | list) else (out,)
        return [o.detach().cpu().numpy() for o in outs]


def run_batch(runner, x: np.ndarray, chunk: int = 64) -> list[np.ndarray]:
    """Every output over a batch, stacked; a runner without a batch path goes one by one."""
    step = chunk if runner.batched else 1
    parts = [runner(np.ascontiguousarray(x[i : i + step])) for i in range(0, len(x), step)]
    return [np.concatenate([p[j] for p in parts]) for j in range(len(parts[0]))]


def hooks_of(run: Path):
    """The branch's quant module: calibration_batches, probe_inputs, score, rank, gate, headline."""
    return tasks.module_of(run, "quant")


@functools.cache
def config_of(run: Path):
    """The run's config as its branch loads it, the one calibration reads too."""
    return tasks.load_run(run)[0]


def row_dir(run: Path, row: str) -> Path:
    return run / INT8_DIR / row


def read_ladder(run: Path) -> dict:
    path = run / INT8_DIR / LADDER_FILE
    return yaml.safe_load(path.read_text(encoding="utf-8")) if path.is_file() else {}


def write_row(run: Path, row: str, entry: dict) -> None:
    rows = read_ladder(run)
    rows[row] = entry
    path = run / INT8_DIR / LADDER_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(rows, sort_keys=False, allow_unicode=True), encoding="utf-8")


def on_grid(x: np.ndarray, exponent: int) -> np.ndarray:
    """x moved onto the int8 grid of exponent, as the chip receives it."""
    return ptq_espdl.to_int8(x, exponent).astype(np.float32) * np.float32(2.0**exponent)


def real_inputs(run: Path, graph, count: int) -> np.ndarray:
    """The first count frames of test_device as the branch cuts them, on graph's input grid."""
    (port, *_), _outputs = ptq_espdl.ports_of(graph)
    frames = hooks_of(run).probe_inputs(config_of(run), device_frames(), count)
    return on_grid(frames, port.exponent)


def quantised(run: Path, rungs: dict, calib: list[torch.Tensor], model=None):
    """The run quantised under rungs and its branch's patches."""
    patches = ptq_espdl.block(tasks.branch_of(run))["esp_ppq_patches"]
    with esp_ppq_patches.applied(patches), tempfile.TemporaryDirectory() as work:
        return ptq_espdl.quantize(run, calib, Path(work), rungs, model)


def is_variant(entry: dict) -> bool:
    """The row is a rounding patch over another row, which only step_variants builds."""
    return "patches" in entry


def row_patches(run: Path, row: str) -> list[str]:
    """The ESP-PPQ patches the row was simulated and exported under."""
    entry = read_ladder(run).get(row, {})
    return entry.get("patches") or ptq_espdl.block(tasks.branch_of(run))["esp_ppq_patches"]


def keep_row(run: Path, row: str, graph, patches: list[str] | None = None) -> Path:
    """Keep graph as the row: its native file, and the .espdl with a real frame as its test input.

    patches default to the branch's. Refused by the same op check update_lock runs before a deploy.
    """
    branch = tasks.branch_of(run)
    folder = row_dir(run, row)
    export_espdl.save_native(graph, folder / GRAPH_FILE)
    with esp_ppq_patches.applied(patches or ptq_espdl.block(branch)["esp_ppq_patches"]):
        espdl = export_espdl.export(graph, folder / f"{branch}.espdl", real_inputs(run, graph, 1))
    if espdl_op_check.main(["--model", str(espdl)]) != 0:
        raise ValueError(f"{espdl}: esp-dl registers no module for one of its operators")
    return espdl


def build_row(run: Path, row: str, rungs: dict, calib: list[torch.Tensor], model=None):
    """The run quantised under rungs and kept as row."""
    graph = quantised(run, rungs, calib, model)
    keep_row(run, row, graph)
    return graph


def ruler_of(run: Path) -> str:
    """The version of the branch's ruler; a row scored under another one is scored again."""
    return getattr(hooks_of(run), "RULER", "")


def current(run: Path, entry: dict) -> bool:
    return "metrics" in entry and entry.get("ruler", "") == ruler_of(run)


def scored(run: Path, runner, ceiling: dict | None) -> dict:
    """The branch's ruler over runner, with the gate against ceiling when there is one."""
    hooks = hooks_of(run)
    metrics = hooks.score(runner, config_of(run))
    entry = {"ruler": ruler_of(run), "metrics": metrics, "headline": hooks.headline(metrics)}
    if ceiling is not None:
        entry["passes"] = bool(hooks.gate(metrics, ceiling))
    return entry


def ceiling_of(run: Path) -> dict:
    """Q0, the float model's metrics, scored once per ruler and kept as the ladder's first row."""
    rows = read_ladder(run)
    if CEILING_ROW not in rows or not current(run, rows[CEILING_ROW]):
        traced = tasks.module_of(run, "eval").export_spec(run)[1]
        write_row(run, CEILING_ROW, {"rung": 0, **scored(run, TorchRunner(traced), None)})
        rows = read_ladder(run)
    return rows[CEILING_ROW]["metrics"]


def verdict(entry: dict) -> str:
    return {True: "pass", False: "fail"}.get(entry.get("passes"), "")


def best_row(run: Path, rungs_wanted: set[int]) -> str:
    """The row of the rungs wanted that ranks first by the branch's ruler, variants left out."""
    hooks, rows = hooks_of(run), read_ladder(run)
    found = [
        name
        for name, e in rows.items()
        if e.get("rung") in rungs_wanted and current(run, e) and not is_variant(e)
    ]
    if not found:
        raise ValueError(f"{run.name}: no row of rung {sorted(rungs_wanted)} yet")
    return max(found, key=lambda name: hooks.rank(rows[name]["metrics"]))


def step_ptq(run: Path) -> None:
    branch = tasks.branch_of(run)
    knobs = ptq_espdl.block(branch)["ladder"]
    patches = ptq_espdl.block(branch)["esp_ppq_patches"]
    ceiling = ceiling_of(run)
    calib = ptq_espdl.calibration(run, knobs["calib_samples"])
    for name in knobs["calibrations"]:
        rungs = {**ptq_espdl.ladder(branch), "calibration": name}
        graph = build_row(run, name, rungs, calib)
        entry = scored(run, ptq_espdl.Simulator(graph, patches), ceiling)
        write_row(run, name, {"rung": 2, "rungs": rungs, **entry})
        print(f"{name}: {entry['headline']}  gate {verdict(entry)}")


def touches_ends(graph, op_name: str) -> bool:
    """op reads a graph input or writes a graph output, where the firmware feeds and reads int8."""
    op = graph.operations[op_name]
    reads_input = any(v.name in graph.inputs for v in op.inputs)
    return reads_input or any(v.name in graph.outputs for v in op.outputs)


def step_int16(run: Path) -> None:
    branch = tasks.branch_of(run)
    knobs = ptq_espdl.block(branch)["ladder"]
    patches = ptq_espdl.block(branch)["esp_ppq_patches"]
    ceiling = ceiling_of(run)
    base = best_row(run, {2})
    base_rungs = read_ladder(run)[base]["rungs"]
    graph = export_espdl.load_native(row_dir(run, base) / GRAPH_FILE)
    calib = ptq_espdl.calibration(run, knobs["calib_samples"])
    with esp_ppq_patches.applied(patches):
        ranked = mixed_espdl.ranked_layers(graph, calib[: knobs["layerwise_samples"]])
    inner = [row for row in ranked if not touches_ends(graph, row[0])]
    for row, ops in mixed_espdl.int16_rows(inner, knobs["int16_tops"]).items():
        rungs = {**base_rungs, "int16_ops": ops}
        quantised = build_row(run, row, rungs, calib)
        entry = scored(run, ptq_espdl.Simulator(quantised, patches), ceiling)
        write_row(run, row, {"rung": 3, "base": base, "rungs": rungs, **entry})
        print(f"{row} over {base}: {entry['headline']}  gate {verdict(entry)}")


def batched(calib: list[torch.Tensor], batch: int) -> list[torch.Tensor]:
    """calib's samples stacked into whole batches of batch."""
    whole = len(calib) // batch * batch
    return [torch.cat(calib[i : i + batch]) for i in range(0, whole, batch)]


def step_qat(run: Path, allow_train: bool, steps: int | None) -> None:
    """Rung 4: the best row trained on through fake quantisation, distilled from the float model.

    It trains on the calibration source past the calibration samples, in batches, then carries the
    trained graph onto one of batch 1, the graph the chip runs.
    """
    if not allow_train:
        raise SystemExit("rung 4 trains the model: ALLOW_TRAIN=1 once the owner says so")
    branch = tasks.branch_of(run)
    knobs = ptq_espdl.block(branch)["ladder"]
    patches = ptq_espdl.block(branch)["esp_ppq_patches"]
    qat = knobs["qat"]
    ceiling = ceiling_of(run)
    base = best_row(run, {2, 3})
    rungs = read_ladder(run)[base]["rungs"]
    calib = ptq_espdl.calibration(run, knobs["calib_samples"])
    taken = knobs["calib_samples"]
    feed = ptq_espdl.calibration(run, taken + qat["batch"] * 64)[taken:]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    teacher = tasks.module_of(run, "eval").export_spec(run)[1].to(device)
    wide = quantised(run, rungs, batched(calib, qat["batch"]))
    student = qat_espdl.Trainable(wide, device)
    optimiser = torch.optim.Adam(student.parameters, lr=qat["learning_rate"])
    rounds = batched(feed, qat["batch"])
    for step in range(steps or qat["steps"]):
        x = rounds[step % len(rounds)].to(device)
        with torch.no_grad():
            want = teacher(x)
        want = want if isinstance(want, tuple | list) else (want,)
        with esp_ppq_patches.applied(patches):
            got = student(x)
        loss = sum(torch.nn.functional.mse_loss(g, w) for g, w in zip(got, want, strict=True))
        optimiser.zero_grad()
        loss.backward()
        optimiser.step()
        if step % 100 == 0:
            print(f"qat step {step}: distillation loss {float(loss):.6f}")
    student.freeze()
    one = quantised(run, rungs, calib)
    qat_espdl.carry(wide, one, calib[0].numpy())
    keep_row(run, "qat", one)
    entry = scored(run, ptq_espdl.Simulator(one, patches), ceiling)
    write_row(run, "qat", {"rung": 4, "base": base, "rungs": rungs, **entry})
    print(f"qat over {base}: {entry['headline']}  gate {verdict(entry)}")


def variant_rows(knobs: dict, base: str) -> list[tuple[str, list[str], list[str]]]:
    """The rows the branch's rounding patches stack over base: name, patches, rounding patches."""
    stacked = knobs["rounding_patches"]
    found = []
    for count in range(1, len(stacked) + 1):
        names = stacked[:count]
        found.append((f"{base}+{'+'.join(names)}", [*knobs["esp_ppq_patches"], *names], names))
    return found


def rewritten(run: Path, row: str, names: list[str]):
    """row's graph, read again and rewritten by each of names that rewrites one, in order."""
    graph = export_espdl.load_native(row_dir(run, row) / GRAPH_FILE)
    for name in names:
        rewrite = esp_ppq_patches.REWRITES.get(name)
        if rewrite is not None:
            rewrite(graph)
    return graph


def step_variants(run: Path) -> None:
    """The branch's rounding patches stacked over its best row: the row's integers, simulated and
    exported as those patches have the chip compute them, then scored like any row (KEHOACH 3.7).
    """
    branch = tasks.branch_of(run)
    knobs = ptq_espdl.block(branch)
    ceiling = ceiling_of(run)
    base = best_row(run, {2, 3, 4})
    entry = read_ladder(run)[base]
    for row, patches, names in variant_rows(knobs, base):
        graph = rewritten(run, base, names)
        keep_row(run, row, graph, patches)
        result = scored(run, ptq_espdl.Simulator(graph, patches), ceiling)
        write_row(
            run,
            row,
            {
                "rung": entry["rung"],
                "base": base,
                "rungs": entry["rungs"],
                "patches": patches,
                **result,
            },
        )
        print(f"{row}: {result['headline']}  gate {verdict(result)}")


def step_timing(run: Path) -> None:
    """The timing row, and beside it the rows its rounding patches stack, for the probe to time."""
    branch = tasks.branch_of(run)
    knobs = ptq_espdl.block(branch)
    rungs = ptq_espdl.timing_rungs(branch)
    calib = ptq_espdl.calibration(run, knobs["ladder"]["calib_samples"])
    keep_row(run, ptq_espdl.TIMING_ROW, quantised(run, rungs, calib))
    write_row(run, ptq_espdl.TIMING_ROW, {"rung": "timing", "rungs": rungs})
    print(f"{ptq_espdl.TIMING_ROW}: {row_dir(run, ptq_espdl.TIMING_ROW)}")
    for row, patches, names in variant_rows(knobs, ptq_espdl.TIMING_ROW):
        keep_row(run, row, rewritten(run, ptq_espdl.TIMING_ROW, names), patches)
        write_row(run, row, {"rung": "timing", "rungs": rungs, "patches": patches})
        print(f"{row}: {row_dir(run, row)}")


def step_same_int8(run: Path, against: str) -> int:
    """KEHOACH 3.7 step 2.4: the run's network as its code stands against its code at against.

    Both are quantised alike; the exit status is 1 when one integer differs.
    """
    branch = tasks.branch_of(run)
    knobs = ptq_espdl.block(branch)["ladder"]
    cfg, current = tasks.load_run(run)
    old_module = ptq_espdl.at_commit(type(current).__module__, against)
    if old_module is None:
        print(f"the network code is {against}'s: nothing to check")
        return 0
    old = getattr(old_module, type(current).__name__)(**dict(cfg.model.params))
    old.load_state_dict(current.state_dict())
    calib = ptq_espdl.calibration(run, knobs["calib_samples"])
    frames = hooks_of(run).probe_inputs(cfg, device_frames(), knobs["check_samples"])
    inputs = [x[None] for x in frames]
    off, worst = ptq_espdl.same_integers(
        run,
        [current, old],
        calib,
        inputs,
        ptq_espdl.ladder(branch),
        ptq_espdl.block(branch)["esp_ppq_patches"],
    )
    print(f"{off} values off between {against} and now, {worst} at most")
    return int(off > 0)


def step_deploy(run: Path, row: str) -> None:
    """The row's .espdl into firmware/models/ and the lock, refused unless every port is int8."""
    branch = tasks.branch_of(run)
    folder = row_dir(run, row)
    bits = ptq_espdl.port_bits(export_espdl.load_native(folder / GRAPH_FILE))
    if bits != {ptq_espdl.BITS}:
        raise SystemExit(f"{row}: the firmware feeds and reads int8, ports carry {sorted(bits)}")
    espdl = folder / f"{branch}.espdl"
    run_id = f"{branch}/{run.name}"
    update_lock.main(
        ["--branch", branch, "--model", str(espdl), "--run-id", run_id, "--arena-bytes", "0"]
    )


def board_ms(run: Path, row: str) -> float | None:
    """The row's mean time a frame on the chip, from the whole graph's probe log; None unprobed."""
    log = row_dir(run, row) / "probe" / "models_0.log"
    found = (
        FRAME_TIME.search(log.read_text(encoding="utf-8", errors="replace"))
        if log.is_file()
        else None
    )
    return int(found.group(1)) / 1000.0 if found else None


def step_choose(run: Path) -> int:
    """KEHOACH 3.7's choice: the best passing row, or a faster one within a step of the ruler.

    Prints every row in reach of the best; exit status 1 while one of them has no probe yet.
    """
    hooks, rows = hooks_of(run), read_ladder(run)
    passing = [name for name, e in rows.items() if e.get("passes") and current(run, e)]
    if not passing:
        raise SystemExit(f"{run.name}: no row passes its gate under ruler {ruler_of(run)!r}")
    best = max(passing, key=lambda name: hooks.rank(rows[name]["metrics"]))
    top = hooks.rank(rows[best]["metrics"])[0]
    near = [n for n in passing if top - hooks.rank(rows[n]["metrics"])[0] <= hooks.RESOLUTION]
    timed = {name: board_ms(run, name) for name in near}
    for name in near:
        ms = timed[name]
        print(
            f"{name:16s} {rows[name]['headline']}  {'unprobed' if ms is None else f'{ms:.1f} ms'}"
        )
    waiting = [name for name, ms in timed.items() if ms is None]
    if waiting:
        print(f"probe before choosing: {' '.join(waiting)}")
        return 1
    chosen = min(near, key=lambda name: (timed[name], -hooks.rank(rows[name]["metrics"])[0]))
    print(f"chosen: {chosen}")
    return 0


def table(run: Path) -> str:
    """The ladder of run as text, one row a line: rung, name, the branch's headline and the gate."""
    lines = []
    for name, e in read_ladder(run).items():
        lines.append(f"{e.get('rung')!s:>6}  {name:16s} {e.get('headline', '')}  {verdict(e)}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    steps = ["ptq", "int16", "qat", "variants", "timing", "same-int8", "choose", "deploy", "table"]
    parser.add_argument("step", choices=steps)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--row", help="deploy: the row to lock")
    parser.add_argument("--against", default="HEAD", help="same-int8: the commit to hold it to")
    parser.add_argument("--allow-train", action="store_true", help="qat: the owner said go")
    parser.add_argument("--steps", type=int, help="qat: steps, the config's when left out")
    args = parser.parse_args(argv)
    run = args.run.resolve()
    if args.step == "ptq":
        step_ptq(run)
    elif args.step == "int16":
        step_int16(run)
    elif args.step == "qat":
        step_qat(run, args.allow_train, args.steps)
    elif args.step == "variants":
        step_variants(run)
    elif args.step == "timing":
        step_timing(run)
    elif args.step == "same-int8":
        return step_same_int8(run, args.against)
    elif args.step == "choose":
        return step_choose(run)
    elif args.step == "deploy":
        if not args.row:
            raise SystemExit("deploy needs --row")
        step_deploy(run, args.row)
    print(table(run))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
