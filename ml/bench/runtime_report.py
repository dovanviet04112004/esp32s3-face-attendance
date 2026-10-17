"""The three-runtime benchmark of KEHOACH 3 layer 5, from the host's scores and bench_ai's runs.

image packs the lock's runs as Q1 .tflite into an experimental lock and a models image;
score runs one branch's locked .espdl or Q1 .tflite through host_bench and the ladder's ruler;
check replays bench_ai's inputs through the .tflite files and compares the board's outputs;
render writes docs/measurements/runtime_compare.md from all of it and each run's build facts.
"""

import argparse
import hashlib
import json
import math
import re
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

import numpy as np
import yaml

ML_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ML_ROOT.parent
sys.path.insert(0, str(ML_ROOT / "src"))
sys.path.insert(0, str(ML_ROOT / "bench"))

LOCK = REPO_ROOT / "contracts" / "models.lock.json"
WORK = ML_ROOT / "artifacts" / "device" / "runtime_compare"
REPORT = REPO_ROOT / "docs" / "measurements" / "runtime_compare.md"
BRANCHES = ("detection", "antispoof", "recognition")
ENTRY = {"detection": "detect", "antispoof": "spoof", "recognition": "recog"}
MODELS = ("detect", "spoof", "recog")
CONFIGS = {"espdl": "ESP-DL", "tflm": "TFLM + esp-nn", "tflm_ansi": "TFLM, esp-nn bản C"}
# The seed bench_ai.c's psram() fills each branch's input with.
INPUT_SEED = {"detection": 1, "antispoof": 2, "recognition": 4}
LIVE_CLASS = 0
INT8_PEAK = 127.0
NORM_EPS = 1e-10
LAYERS = ("CONV_2D", "DEPTHWISE_CONV_2D", "FULLY_CONNECTED")
ARCHIVE_DIFF_BYTES = 1024
COMPONENTS = ("espressif/esp-dl", "espressif/esp-tflite-micro", "espressif/esp-nn")
TIMES = "\u00d7"
OPTIMIZATION = {"PERF": "-O2", "SIZE": "-Os", "DEBUG": "-Og", "NONE": "-O0"}
SPEEDUPS = (
    ("tflm", "espdl", "ESP-DL so với TFLM + esp-nn"),
    ("tflm_ansi", "tflm", "esp-nn so với bản C"),
    ("tflm_ansi", "espdl", "ESP-DL so với TFLM bản C"),
)

ANSI = re.compile(r"\x1b\[[0-9;]*m")
TIMING = re.compile(
    r"^(detect|spoof|recog|pass)\s+median\s+(\d+) us\s+p95\s+(\d+) us\s+min\s+(\d+) us"
    r"\s+max\s+(\d+) us\s+mean\s+(\d+) us"
)
ALONE = re.compile(r"^(idle|under load), each branch alone: one face end to end (\d+) us")
INTERLEAVED = re.compile(r"^(idle|under load), interleaved:")
SETUP = re.compile(
    r"^timing: (\d+) warm-up and (\d+) timed runs, load copies (\d+) B every (\d+) ms on core (\d+)"
)
LOAD = re.compile(r"^load moved (\d+) frames, (\d+) KB in (\d+) ms, (\d+) KB/s of psram")
INIT = re.compile(r"^init (\d+) ms, took internal (\d+) KB and psram (\d+) KB")
FREE = re.compile(r"^free after init: internal (\d+) KB, psram (\d+) KB, largest psram block (\d+)")
ARENA = re.compile(r"^arena_(fast|big)\s+(\d+) B of (\d+) KB")
ESPDL_BUILT = re.compile(
    r"(detect|spoof|recog): built in (\d+) us, weights in (psram|flash), internal (\d+) B, "
    r"psram (\d+) B"
)
TFLM_BUILT = re.compile(r"(detect|spoof|recog): \d+ in, \d+ out, arena at (\d+) of (\d+) KB")
HASH = re.compile(
    r"^hash detect ([0-9a-f]{8}) \((\d+) faces\)\s+spoof ([0-9a-f]{8}) \(live (-?[0-9.]+)\)"
    r"\s+recog ([0-9a-f]{8})"
)
HEAP = re.compile(r"^after (\d+) passes: internal (-?\d+) B, psram (-?\d+) B")
STACK = re.compile(r"^stack: one pass took (\d+) B of the probe's (\d+) B")
EMBEDDING = re.compile(r"^embedding ([0-9a-f]+) scale ([0-9a-f]{8})")
WEIGHTS = re.compile(
    r"^weights (\d+) KB: copy from flash (\d+) us, crc32 over the psram copy (\d+) us"
)
GRAPH_TEST = re.compile(r"^(detect|spoof|recog): (\d+) KB, test (PASS|FAIL)")
SUMMARY = re.compile(r"(\d+) Tests (\d+) Failures (\d+) Ignored")
HEAP_REGION = re.compile(r"heap_init: At [0-9A-F]+ len ([0-9A-F]+) \(\d+ KiB\): RAM$")
BOOT = {
    "chip_rev": re.compile(r"boot: chip revision: (\S+)"),
    "flash_size": re.compile(r"SPI Flash Size : (\S+)"),
    "flash_mode": re.compile(r"SPI Mode\s+: (\S+)"),
    "flash_speed": re.compile(r"Boot SPI Speed : (\S+)"),
    "flash_chip": re.compile(r"spi_flash: detected chip: (\S+)"),
    "psram_size": re.compile(r"esp_psram: Found (\S+) PSRAM device"),
    "psram_speed": re.compile(r"esp_psram: Speed: (\S+)"),
    "psram_vendor": re.compile(r"octal_psram: vendor id\s*: \S+ \((.+)\)"),
    "psram_generation": re.compile(r"octal_psram: dev id\s*: \S+ \((.+)\)"),
    "cpu_hz": re.compile(r"cpu_start: cpu freq: (\d+) Hz"),
    "idf": re.compile(r"app_init: ESP-IDF:\s+(\S+)"),
    "main_core": re.compile(r"main_task: Started on CPU(\d)"),
}


def lock_entries() -> dict:
    return json.loads(LOCK.read_text(encoding="utf-8"))


def run_of(branch: str) -> Path:
    run_name = lock_entries()[branch]["run_id"].split("/", 1)[1]
    return ML_ROOT / "artifacts" / branch / "runs" / run_name


def tflite_of(branch: str) -> Path:
    """The Q1 file 30_quantize.sh wrote for the locked run, tagged <hour>_<cfghash>."""
    from facepipe.core.config import load_run_config

    run = run_of(branch)
    hour, _commit, cfghash = run.name.split("-", 1)[1].split("_")
    model = load_run_config(run).model.name
    return ML_ROOT / "artifacts" / branch / "tflite" / f"{model}_int8_q1_{hour}_{cfghash}.tflite"


def espdl_of(branch: str) -> Path:
    import host_bench

    return host_bench.locked_espdl(run_of(branch))


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def image(args: argparse.Namespace) -> int:
    from facepipe.export import pack_models_partition, update_lock

    lock = args.out / "lock" / "models.lock.json"
    models = args.out / "lock" / "models"
    lock.unlink(missing_ok=True)
    # Spoof and recog share arena_big, so each carries the pair's total (KEHOACH 3.8).
    arena = {
        "detection": args.arena_fast,
        "antispoof": args.arena_big,
        "recognition": args.arena_big,
    }
    for branch in BRANCHES:
        entry = lock_entries()[branch]
        update_lock.main(
            [
                *("--branch", branch, "--model", str(tflite_of(branch))),
                *("--run-id", entry["run_id"], "--arena-bytes", str(arena[branch])),
                *("--threshold-permille", str(entry["threshold_permille"])),
                *("--artifacts", str(ML_ROOT / "artifacts"), "--lock", str(lock)),
                *("--models-dir", str(models)),
            ]
        )
    return pack_models_partition.main(
        [
            *("--lock", str(lock), "--models-dir", str(models)),
            *("--partitions", str(REPO_ROOT / "firmware" / "partitions.dev.csv")),
            *("--out", str(args.out / "models_tflm.bin")),
        ]
    )


def score(args: argparse.Namespace) -> int:
    import host_bench

    from facepipe.compress.quant import ladder

    run = run_of(args.branch)
    model = espdl_of(args.branch) if args.runtime == "espdl" else tflite_of(args.branch)
    started = time.monotonic()
    runner = host_bench.build_runner(args.runtime, model, run)
    hooks = ladder.hooks_of(run)
    metrics = hooks.score(runner, ladder.config_of(run))
    result = {
        "branch": args.branch,
        "runtime": args.runtime,
        "model": str(model.relative_to(REPO_ROOT)),
        "sha256": sha256_of(model),
        "run_id": lock_entries()[args.branch]["run_id"],
        "seconds": round(time.monotonic() - started),
        "headline": hooks.headline(metrics),
        "metrics": metrics,
    }
    out = args.out / "scores" / f"{args.branch}_{args.runtime}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2, default=float) + "\n", encoding="utf-8")
    print(f"{args.branch} {args.runtime}: {result['headline']}")
    return 0


def bench_input(size: int, seed: int) -> np.ndarray:
    """What bench_ai's psram() writes: ((i * 31) + seed * 97) % 255 - 128, as int8."""
    index = np.arange(size, dtype=np.int64)
    return (((index * 31) + seed * 97) % 255 - 128).astype(np.int8)


def first_output(branch: str, reference: bool = True) -> tuple[np.ndarray, float, int]:
    """Output 0 of the branch's .tflite on bench_ai's input, on the kernels TFLM reproduces.

    reference=False runs TFLite's default kernels instead, to show how far rounding alone moves it.
    """
    import host_bench
    from ai_edge_litert.interpreter import Interpreter, OpResolverType

    path = tflite_of(branch)
    interpreter = (
        host_bench.reference_interpreter(path)
        if reference
        else Interpreter(
            model_path=str(path),
            experimental_op_resolver_type=OpResolverType.BUILTIN_WITHOUT_DEFAULT_DELEGATES,
        )
    )
    interpreter.allocate_tensors()
    detail = interpreter.get_input_details()[0]
    size = int(np.prod(detail["shape"]))
    feed = bench_input(size, INPUT_SEED[branch]).reshape(detail["shape"])
    interpreter.set_tensor(detail["index"], feed)
    interpreter.invoke()
    out = interpreter.get_output_details()[0]
    scale, zero = out["quantization"]
    return interpreter.get_tensor(out["index"]).reshape(-1), float(scale), int(zero)


def live_score(logits: np.ndarray, scale: float, zero: int) -> np.float32:
    """ai::live_score of live_score.cpp in float32: softmax over the dequantised logits."""
    value = [np.float32(scale) * np.float32(int(q) - zero) for q in logits]
    top = max(value)
    total = np.float32(0.0)
    for v in value:
        total = np.float32(total + np.exp(np.float32(v - top)))
    return np.float32(np.exp(np.float32(value[LIVE_CLASS] - top)) / total)


def normalized_int8(raw: np.ndarray, scale: float, zero: int, fused: bool) -> bytes:
    """ai::normalized_int8 of l2norm.cpp: the int8 vector, then its scale, as bench_ai hashes.

    fused rounds the sum of squares once per step, as a multiply-add would.
    """
    unit = [np.float32((np.float32(int(q)) - np.float32(zero)) * np.float32(scale)) for q in raw]
    sum_sq = np.float32(0.0)
    for u in unit:
        if fused:
            sum_sq = np.float32(float(u) * float(u) + float(sum_sq))
        else:
            sum_sq = np.float32(sum_sq + np.float32(u * u))
    norm = np.float32(np.sqrt(sum_sq))
    inverse = np.float32(np.float32(1.0) / max(norm, np.float32(NORM_EPS)))
    unit = [np.float32(u * inverse) for u in unit]
    peak = max(abs(u) for u in unit)
    out_scale = np.float32(peak / np.float32(INT8_PEAK)) if peak > 0 else np.float32(0.0)
    quantised = []
    for u in unit:
        q = np.rint(np.float32(u / out_scale)) if out_scale > 0 else 0.0
        quantised.append(int(max(-INT8_PEAK, min(INT8_PEAK, q))))
    return np.array(quantised, dtype=np.int8).tobytes() + struct.pack("<f", float(out_scale))


def crc32(data: bytes) -> str:
    """esp_crc32_le(0, ...) is zlib's crc32: same table, same inversions."""
    return f"{zlib.crc32(data):08x}"


def apart(a: bytes, b: bytes) -> dict:
    """How far two packed embeddings lie: elements that differ, the widest step, their cosine."""
    qa = np.frombuffer(a[:-4], dtype=np.int8).astype(np.int32)
    qb = np.frombuffer(b[:-4], dtype=np.int8).astype(np.int32)
    va = qa * np.float64(struct.unpack("<f", a[-4:])[0])
    vb = qb * np.float64(struct.unpack("<f", b[-4:])[0])
    cosine = float(va @ vb / (np.linalg.norm(va) * np.linalg.norm(vb)))
    widest = int(np.max(np.abs(qa - qb)))
    return {
        "differ": int(np.count_nonzero(qa != qb)),
        "of": int(qa.size),
        "widest": widest,
        "cosine": cosine,
    }


def check(args: argparse.Namespace) -> int:
    logits, scale, zero = first_output("antispoof")
    live = live_score(logits, scale, zero)
    raw, raw_scale, raw_zero = first_output("recognition")
    plain = normalized_int8(raw, raw_scale, raw_zero, fused=False)
    other = normalized_int8(*first_output("recognition", reference=False), fused=False)
    host = {
        "spoof_live": float(live),
        "spoof_hash": crc32(struct.pack("<f", float(live))),
        "recog_hash_plain": crc32(plain),
        "recog_hash_fused": crc32(normalized_int8(raw, raw_scale, raw_zero, fused=True)),
        "recog_default_kernels": apart(plain, other),
    }
    boards = {}
    for config in ("tflm", "tflm_ansi"):
        parsed = parse_log(args.out / config / "bench.log")
        if parsed.get("hash"):
            boards[config] = dict(parsed["hash"])
        if parsed.get("embedding"):
            boards[config]["embedding_vs_host"] = apart(plain, parsed["embedding"])
    result = {"host": host, "boards": boards}
    out = args.out / "check.json"
    out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    return 0


def first_hit(lines: list[str], pattern: re.Pattern) -> tuple | None:
    return next((hit.groups() for line in lines if (hit := pattern.search(line))), None)


def timings(lines: list[str]) -> dict:
    """Median, p95, min, max and mean of every timing line, by test case."""
    found: dict = {"alone": {}, "interleaved": {}}
    waiting: dict = {}
    section = None
    for line in lines:
        if hit := INTERLEAVED.search(line):
            section = hit.group(1)
            found["interleaved"][section] = {}
        elif hit := TIMING.search(line):
            keys = ("median", "p95", "min", "max", "mean")
            row = dict(zip(keys, (int(v) for v in hit.groups()[1:]), strict=True))
            if section is not None:
                found["interleaved"][section][hit.group(1)] = row
                section = None if hit.group(1) == "pass" else section
            else:
                waiting[hit.group(1)] = row
        elif hit := ALONE.search(line):
            found["alone"][hit.group(1)] = {**waiting, "sum": int(hit.group(2))}
            waiting = {}
    return found


def built_models(lines: list[str]) -> dict:
    """What each model took when it was built: ESP-DL's own heap, or TFLM's arena mark."""
    built: dict = {}
    for line in lines:
        if hit := ESPDL_BUILT.search(line):
            name, us, where, internal, psram = hit.groups()
            built[name] = {"us": int(us), "weights": where, "internal": int(internal)}
            built[name]["psram"] = int(psram)
        elif hit := TFLM_BUILT.search(line):
            built[hit.group(1)] = {"arena_kb": int(hit.group(2)), "arena_of_kb": int(hit.group(3))}
    return built


def parse_log(path: Path) -> dict:
    """Every number bench_ai printed, or an empty dict when the run is missing."""
    if not path.is_file():
        return {}
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = [ANSI.sub("", raw).strip() for raw in text.splitlines()]
    found = timings(lines)
    found["boot"] = {
        key: got[0] for key, pattern in BOOT.items() if (got := first_hit(lines, pattern))
    }
    regions = (hit for line in lines if (hit := HEAP_REGION.search(line)))
    found["heap_ram_bytes"] = sum(int(hit.group(1), 16) for hit in regions)
    found["built"] = built_models(lines)
    loads = (hit for line in lines if (hit := LOAD.search(line)))
    found["loads"] = [int(hit.group(4)) for hit in loads]
    arenas = (hit for line in lines if (hit := ARENA.search(line)))
    found["arena"] = {
        hit.group(1): {"used": int(hit.group(2)), "kb": int(hit.group(3))} for hit in arenas
    }
    tests = (hit for line in lines if (hit := GRAPH_TEST.search(line)))
    found["graph_test"] = {hit.group(1): hit.group(3) for hit in tests}
    named = {
        "setup": (SETUP, ("warmup", "runs", "frame_bytes", "period_ms", "core")),
        "heap": (HEAP, ("passes", "internal", "psram")),
        "stack": (STACK, ("used", "size")),
        "weights": (WEIGHTS, ("kb", "copy_us", "crc_us")),
    }
    for key, (pattern, fields) in named.items():
        if got := first_hit(lines, pattern):
            found[key] = dict(zip(fields, map(int, got), strict=True))
    if got := first_hit(lines, INIT):
        found["init_ms"], found["internal_kb"], found["psram_kb"] = map(int, got)
    if got := first_hit(lines, FREE):
        found["free_internal_kb"], found["free_psram_kb"], found["largest_kb"] = map(int, got)
    if got := first_hit(lines, HASH):
        detect, faces, spoof, live, recog = got
        found["hash"] = {"detect": detect, "faces": int(faces), "spoof": spoof, "recog": recog}
        found["hash"]["live"] = float(live)
    if got := first_hit(lines, EMBEDDING):
        found["embedding"] = bytes.fromhex(got[0]) + struct.pack("<I", int(got[1], 16))
    if got := first_hit(lines, SUMMARY):
        found["summary"] = {"tests": int(got[0]), "failures": int(got[1])}
    return found


def sdkconfig_of(path: Path) -> dict[str, str]:
    found = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("CONFIG_") and "=" in line:
            key, value = line.removeprefix("CONFIG_").split("=", 1)
            found[key] = value.strip('"')
    return found


def compiler_of(path: str) -> str:
    """The GCC release in the toolchain's folder name, such as esp-15.2.0_20251204."""
    hit = re.search(r"esp-(\d+\.\d+\.\d+)_(\d+)", path)
    return f"GCC {hit.group(1)} (`esp-{hit.group(1)}_{hit.group(2)}`)" if hit else Path(path).name


def facts(out: Path, config: str) -> dict:
    """What fw-bench-ai-facts kept of the build that ran, or an empty dict before its run."""
    folder = out / config
    if not (folder / "size.json").is_file():
        return {}

    def read(name: str) -> dict:
        return json.loads((folder / name).read_text(encoding="utf-8"))

    size, archives, project = (
        read("size.json"),
        read("components.json"),
        read("project_description.json"),
    )
    locked = yaml.safe_load((folder / "dependencies.lock").read_text(encoding="utf-8"))
    return {
        "image_bytes": size["total_size"],
        "layout": {kind["name"]: kind for kind in size["layout"]},
        "archives": {
            Path(name).name.removeprefix("lib").removesuffix(".a"): info
            for name, info in archives.items()
        },
        "sdkconfig": sdkconfig_of(folder / "sdkconfig"),
        "compiler": compiler_of(project["c_compiler"]),
        "app_version": project["project_version"],
        "versions": {name: str(locked["dependencies"][name]["version"]) for name in COMPONENTS},
    }


def complexity(path: Path) -> dict:
    """Input, parameters and MACs of one .tflite graph's conv, depthwise and FC layers."""
    import host_bench

    interpreter = host_bench.reference_interpreter(path)
    shape = {d["index"]: [int(v) for v in d["shape"]] for d in interpreter.get_tensor_details()}
    params = macs = 0
    for op in interpreter._get_ops_details():
        if op["op_name"] not in LAYERS:
            continue
        weight, out = shape[op["inputs"][1]], shape[op["outputs"][0]]
        params += sum(math.prod(shape[i]) for i in op["inputs"][1:] if i >= 0)
        reach = weight[1:3] if op["op_name"] == "DEPTHWISE_CONV_2D" else weight[1:]
        macs += math.prod(out) * math.prod(reach)
    image_shape = interpreter.get_input_details()[0]["shape"][1:]
    return {"input": TIMES.join(str(int(v)) for v in image_shape), "params": params, "macs": macs}


def vn(value: float, digits: int = 0) -> str:
    """A number as Vietnamese writes it: dots between thousands, a comma before decimals."""
    return f"{value:,.{digits}f}".translate(str.maketrans({",": ".", ".": ","}))


def ms(us: float | None) -> str:
    return "—" if us is None else vn(us / 1000, 1)


def kb(count: float | None) -> str:
    return "—" if count is None else vn(count / 1024, 1)


def num(value: float | None, digits: int = 4) -> str:
    return "—" if value is None else f"{value:.{digits}f}".replace(".", ",")


def ratio(slow: float | None, fast: float | None) -> str:
    return "—" if not slow or not fast else f"{vn(slow / fast, 2)}{TIMES}"


def table(head: list[str], rows: list[list[str]]) -> list[str]:
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    return lines + ["| " + " | ".join(row) + " |" for row in rows]


def alone(logs: dict, config: str, when: str, name: str) -> int | None:
    got = logs[config].get("alone", {}).get(when, {}).get(name)
    return None if got is None else got["median"]


def one_pass(logs: dict, config: str, when: str) -> int | None:
    got = logs[config].get("interleaved", {}).get(when, {}).get("pass")
    return None if got is None else got["median"]


def archive_bytes(build: dict, name: str) -> tuple[int, int] | None:
    """Flash and static RAM one archive takes, or None when the build links none of it."""
    info = build.get("archives", {}).get(name)
    if not info or not info["size"]:
        return None
    kinds = info["memory_types"]
    flash = sum(kind["size"] for key, kind in kinds.items() if key.startswith("Flash"))
    return flash, info["size"] - flash


def differing_archives(builds: dict) -> list[str]:
    """Every archive whose size moves by ARCHIVE_DIFF_BYTES or more between builds, largest first.

    Direct libraries and what they pull in alike, so no runtime's cost hides in libstdc++.
    """
    names = {name for build in builds.values() for name in build.get("archives", {})}
    sizes = {
        n: [builds[c].get("archives", {}).get(n, {}).get("size", 0) for c in CONFIGS] for n in names
    }
    moved = [n for n, got in sizes.items() if max(got) - min(got) >= ARCHIVE_DIFF_BYTES]
    return sorted(moved, key=lambda n: -max(sizes[n]))


def pick(values: dict[str, str]) -> str:
    """One value when every run agrees on it, else each run's own."""
    if len(set(values.values())) == 1:
        return next(iter(values.values()))
    return "; ".join(f"{CONFIGS[config]}: {value}" for config, value in values.items())


def cache_of(sdk: dict[str, str]) -> str:
    parts = []
    for kind, name in (("INSTRUCTION", "lệnh"), ("DATA", "dữ liệu")):
        prefix = f"ESP32S3_{kind}_CACHE_"
        size_kb = int(sdk.get(prefix + "SIZE", "0"), 16) // 1024
        ways = [k.removeprefix(prefix).removesuffix("WAYS") for k in sdk if k.startswith(prefix)]
        ways = [w for w in ways if w.isdigit()]
        line = sdk.get(prefix + "LINE_SIZE", "?")
        parts.append(f"{name} {size_kb} KB, {''.join(ways) or '?'} đường, dòng {line} B")
    return "; ".join(parts)


def optimization_of(sdk: dict[str, str]) -> str:
    level = next((k for k in OPTIMIZATION if sdk.get(f"COMPILER_OPTIMIZATION_{k}") == "y"), None)
    return "?" if level is None else f"`{OPTIMIZATION[level]}` (`COMPILER_OPTIMIZATION_{level}`)"


def differing_kconfig(builds: dict) -> dict[str, str]:
    """The sdkconfig keys the builds set differently, as each build sets them."""
    sdks = {config: build["sdkconfig"] for config, build in builds.items() if build}
    keys = sorted({key for sdk in sdks.values() for key in sdk})
    moved = [key for key in keys if len({sdk.get(key) for sdk in sdks.values()}) > 1]
    return {
        config: ", ".join(
            f"`{k}`" if sdk[k] == "y" else f"`{k}={sdk[k]}`" for k in moved if k in sdk
        )
        for config, sdk in sdks.items()
    }


def environment_rows(logs: dict, builds: dict) -> list[list[str]]:
    ran = [config for config in CONFIGS if logs[config]]

    def each(value) -> str:
        return pick(
            {c: value(logs[c], logs[c]["boot"], builds[c].get("sdkconfig", {})) for c in ran}
        )

    def chip(log, boot, sdk):
        mhz = int(boot.get("cpu_hz", 0)) // 1_000_000
        return f"ESP32-S3 {boot.get('chip_rev', '?')}, CPU {mhz} MHz"

    def cores(log, boot, sdk):
        load_core = log.get("setup", {}).get("core", "?")
        return f"model ở lõi {boot.get('main_core', '?')} (main task), tải PSRAM ở lõi {load_core}"

    def flash(log, boot, sdk):
        return (
            f"{boot.get('flash_size', '?')}, {boot.get('flash_mode', '?')} "
            f"{boot.get('flash_speed', '?')}, chip {boot.get('flash_chip', '?')}"
        )

    def psram(log, boot, sdk):
        mode = "octal" if sdk.get("SPIRAM_MODE_OCT") == "y" else "quad"
        return (
            f"{boot.get('psram_size', '?')} {mode} {boot.get('psram_speed', '?')}, "
            f"{boot.get('psram_vendor', '?')}, {boot.get('psram_generation', '?')}"
        )

    def runs(log, boot, sdk):
        setup = log.get("setup")
        if setup is None:
            return "?"
        return f"{setup['warmup']} lượt khởi động rồi {setup['runs']} lượt đo cho mỗi số"

    def load(log, boot, sdk):
        setup, rates = log.get("setup"), log.get("loads", [])
        if setup is None or not rates:
            return "?"
        return (
            f"chép {vn(setup['frame_bytes'])} B mỗi {setup['period_ms']} ms: "
            f"{vn(min(rates))} đến {vn(max(rates))} KB/s mỗi chiều"
        )

    def versions(c: str) -> str:
        found = builds[c].get("versions", {})
        return " · ".join(f"{name.split('/', 1)[1]} {v}" for name, v in found.items()) or "?"

    return [
        ["Chip", each(chip)],
        ["Lõi", each(cores)],
        ["Flash", each(flash)],
        ["PSRAM", each(psram)],
        ["Cache", each(lambda log, boot, sdk: cache_of(sdk))],
        [
            "RAM nội cho heap lúc khởi động",
            each(lambda log, boot, sdk: f"{kb(log['heap_ram_bytes'])} KB"),
        ],
        ["ESP-IDF", each(lambda log, boot, sdk: boot.get("idf", "?"))],
        ["Trình biên dịch", pick({c: builds[c].get("compiler", "?") for c in ran})],
        ["Mức tối ưu", each(lambda log, boot, sdk: optimization_of(sdk))],
        ["FreeRTOS", each(lambda log, boot, sdk: f"tick {sdk.get('FREERTOS_HZ', '?')} Hz")],
        ["Thư viện", pick({c: versions(c) for c in ran})],
        ["Bản build", pick({c: f"`{builds[c].get('app_version', '?')}`" for c in ran})],
        ["Lặp", each(runs)],
        ["Đầu vào", "ảnh tổng hợp tất định của `bench_ai`, cùng một ảnh cho cả ba cấu hình"],
        ["Tải PSRAM", each(load)],
        ["Kconfig khác nhau giữa các bản build", pick(differing_kconfig(builds))],
    ]


def summary_rows(logs: dict, builds: dict) -> list[list[str]]:
    def cell(config: str, key: str) -> str:
        value = logs[config].get(key)
        return "—" if value is None else vn(value)

    def stack(config: str) -> str:
        got = logs[config].get("stack")
        return "—" if got is None else vn(got["used"])

    def static_ram(config: str) -> str:
        kind = builds[config].get("layout", {}).get("DIRAM")
        return "—" if kind is None else kb(kind["used"])

    base = one_pass(logs, "espdl", "idle")
    return [
        [
            "**Một lượt ba model, rảnh (ms)**",
            *(f"**{ms(one_pass(logs, c, 'idle'))}**" for c in CONFIGS),
        ],
        ["Chậm hơn ESP-DL", *(ratio(one_pass(logs, c, "idle"), base) for c in CONFIGS)],
        ["Một lượt, có tải preview (ms)", *(ms(one_pass(logs, c, "under load")) for c in CONFIGS)],
        ["Ảnh app `bench_ai` (KB)", *(kb(builds[c].get("image_bytes")) for c in CONFIGS)],
        ["RAM tĩnh, DIRAM (KB)", *(static_ram(c) for c in CONFIGS)],
        ["PSRAM lấy khi dựng ba model (KB)", *(cell(c, "psram_kb") for c in CONFIGS)],
        ["RAM nội lấy khi dựng ba model (KB)", *(cell(c, "internal_kb") for c in CONFIGS)],
        ["Đỉnh stack một lượt ba model (B)", *(stack(c) for c in CONFIGS)],
    ]


def model_rows(sizes: dict) -> list[list[str]]:
    rows = []
    for branch in BRANCHES:
        espdl, tflite, got = espdl_of(branch), tflite_of(branch), sizes[branch]
        rows.append(
            [
                f"`{ENTRY[branch]}` `{lock_entries()[branch]['run_id'].split('/', 1)[1]}`",
                got["input"],
                vn(got["params"] / 1e6, 2),
                vn(got["macs"] / 1e6, 1),
                f"`{espdl.parent.name}/{espdl.name}` {kb(espdl.stat().st_size)} KB",
                f"`{tflite.name}` {kb(tflite.stat().st_size)} KB",
            ]
        )
    return rows


def timing_rows(logs: dict, when: str) -> list[list[str]]:
    rows = []
    for name in MODELS:
        cells = [f"`{name}`"]
        for config in CONFIGS:
            got = logs[config].get("alone", {}).get(when, {}).get(name)
            cells.append("—" if got is None else f"{ms(got['median'])} / {ms(got['p95'])}")
        rows.append(cells)
    cells = ["một lượt, ba model nối nhau"]
    for config in CONFIGS:
        got = logs[config].get("interleaved", {}).get(when, {}).get("pass")
        cells.append("—" if got is None else f"**{ms(got['median'])}** / {ms(got['p95'])}")
    return [*rows, cells]


def speed_rows(logs: dict, macs: dict[str, int]) -> list[list[str]]:
    def hz(config: str) -> int:
        return int(logs[config].get("boot", {}).get("cpu_hz", 0))

    def per_second(us: int | None) -> str:
        return "—" if not us else vn(1e6 / us, 2)

    def per_cycle(count: int, us: int | None, cpu_hz: int) -> str:
        return "—" if not us or not cpu_hz else vn(count / (us * 1e-6 * cpu_hz), 2)

    def slower(config: str) -> str:
        idle, load = one_pass(logs, config, "idle"), one_pass(logs, config, "under load")
        return "—" if not idle or not load else f"+{vn((load / idle - 1) * 100, 1)}%"

    rows = [
        [
            "`detect`: khung mỗi giây",
            *(per_second(alone(logs, c, "idle", "detect")) for c in CONFIGS),
        ],
        [
            "Một lượt ba model: mặt mỗi giây",
            *(per_second(one_pass(logs, c, "idle")) for c in CONFIGS),
        ],
    ]
    for name in MODELS:
        rows.append(
            [
                f"`{name}`: MAC mỗi chu kỳ CPU",
                *(per_cycle(macs[name], alone(logs, c, "idle", name), hz(c)) for c in CONFIGS),
            ]
        )
    total = sum(macs.values())
    rows.append(
        [
            "Một lượt ba model: MAC mỗi chu kỳ CPU",
            *(per_cycle(total, one_pass(logs, c, "idle"), hz(c)) for c in CONFIGS),
        ]
    )
    rows.append(["Có tải preview: một lượt chậm đi", *(slower(c) for c in CONFIGS)])
    return rows


def speedup_rows(logs: dict) -> list[list[str]]:
    rows = [
        [
            f"`{name}`",
            *(
                ratio(alone(logs, s, "idle", name), alone(logs, f, "idle", name))
                for s, f, _ in SPEEDUPS
            ),
        ]
        for name in MODELS
    ]
    passes = (ratio(one_pass(logs, s, "idle"), one_pass(logs, f, "idle")) for s, f, _ in SPEEDUPS)
    return [*rows, ["một lượt ba model", *passes]]


def static_rows(builds: dict) -> list[list[str]]:
    kinds: list[str] = []
    for build in builds.values():
        kinds += [name for name in build.get("layout", {}) if name not in kinds]
    rows = [["Ảnh app `bench_ai.bin` (KB)", *(kb(builds[c].get("image_bytes")) for c in CONFIGS)]]
    for name in kinds:
        cells = []
        for config in CONFIGS:
            kind = builds[config].get("layout", {}).get(name)
            if kind is None:
                cells.append("—")
            elif kind["total"]:
                cells.append(f"{kb(kind['used'])} / {kb(kind['total'])}")
            else:
                cells.append(kb(kind["used"]))
        rows.append([f"{name} (KB dùng / có)", *cells])
        if not name.startswith("Flash"):
            rows += [
                [f"· `{part}` (KB)", *part_sizes(builds, name, part)]
                for part in parts_of(builds, name)
            ]
    return rows


def parts_of(builds: dict, kind: str) -> list[str]:
    found: list[str] = []
    for build in builds.values():
        found += [
            p for p in build.get("layout", {}).get(kind, {}).get("parts", {}) if p not in found
        ]
    return found if len(found) > 1 else []


def part_sizes(builds: dict, kind: str, part: str) -> list[str]:
    parts = (builds[c].get("layout", {}).get(kind, {}).get("parts", {}) for c in CONFIGS)
    return [kb(found.get(part, {}).get("size")) for found in parts]


def library_rows(builds: dict) -> list[list[str]]:
    names = differing_archives(builds)
    rows = []
    for name in names:
        found = (archive_bytes(builds[c], name) for c in CONFIGS)
        label = f"`{name.removeprefix('espressif__')}`"
        rows.append(
            [label, *("—" if got is None else f"{kb(got[0])} · {kb(got[1])}" for got in found)]
        )
    totals = []
    for config in CONFIGS:
        found = [got for name in names if (got := archive_bytes(builds[config], name))]
        flash, ram = sum(f for f, _ in found), sum(r for _, r in found)
        totals.append(f"**{kb(flash)} · {kb(ram)}**" if found else "—")
    return [*rows, ["**Cộng các dòng trên**", *totals]]


def runtime_memory_rows(logs: dict) -> list[list[str]]:
    def cell(config: str, key: str) -> str:
        value = logs[config].get(key)
        return "—" if value is None else vn(value)

    def model(config: str, name: str) -> str:
        got = logs[config].get("built", {}).get(name)
        if got is None:
            return "—"
        if "psram" in got:
            return (
                f"PSRAM {kb(got['psram'])} KB, nội {vn(got['internal'])} B, dựng {ms(got['us'])} ms"
            )
        arena = "arena_fast" if name == "detect" else "arena_big"
        return f"{arena} tới {vn(got['arena_kb'])} KB"

    def arena(config: str) -> str:
        found = logs[config].get("arena", {})
        if not found or not any(v["used"] for v in found.values()):
            return "không có arena chung"
        return " + ".join(
            f"{name} {kb(v['used'])} KB / {vn(v['kb'])} KB" for name, v in found.items()
        )

    def weights_at(config: str) -> str:
        built = logs[config].get("built", {})
        if not built:
            return "—"
        if all(got.get("weights") == "psram" for got in built.values()):
            return "PSRAM, chép khi dựng"
        return "flash, đọc qua mmap"

    def free_psram(config: str) -> str:
        found = logs[config]
        if "free_psram_kb" not in found:
            return "—"
        return f"{vn(found['free_psram_kb'])} / {vn(found['largest_kb'])}"

    def stack(config: str) -> str:
        got = logs[config].get("stack")
        return "—" if got is None else f"{vn(got['used'])} B / {vn(got['size'])} B"

    def heap(config: str) -> str:
        got = logs[config].get("heap")
        return "—" if got is None else f"{got['internal']} B nội, {got['psram']} B PSRAM"

    def copy(config: str) -> str:
        got = logs[config].get("weights")
        if got is None:
            return "—"
        rate = got["kb"] / 1024 / (got["copy_us"] * 1e-6)
        return f"{vn(got['kb'])} KB trong {ms(got['copy_us'])} ms, {vn(rate, 1)} MB/s"

    def crc(config: str) -> str:
        got = logs[config].get("weights")
        return "—" if got is None else ms(got["crc_us"])

    passes = next((logs[c]["heap"]["passes"] for c in CONFIGS if logs[c].get("heap")), "?")
    return [
        ["Dựng ba model (ms)", *(cell(c, "init_ms") for c in CONFIGS)],
        ["RAM nội lấy khi dựng (KB)", *(cell(c, "internal_kb") for c in CONFIGS)],
        ["PSRAM lấy khi dựng (KB)", *(cell(c, "psram_kb") for c in CONFIGS)],
        *([f"`{name}` khi dựng", *(model(c, name) for c in CONFIGS)] for name in MODELS),
        ["Arena TFLM đã dùng / cấp", *(arena(c) for c in CONFIGS)],
        ["Trọng số khi chạy nằm ở", *(weights_at(c) for c in CONFIGS)],
        ["RAM nội còn trống sau khi dựng (KB)", *(cell(c, "free_internal_kb") for c in CONFIGS)],
        ["PSRAM còn trống / khối liền lớn nhất (KB)", *(free_psram(c) for c in CONFIGS)],
        ["Đỉnh stack một lượt ba model / stack của task thăm dò", *(stack(c) for c in CONFIGS)],
        [f"Heap sau {passes} lượt so với lượt đầu", *(heap(c) for c in CONFIGS)],
        [
            "Chép cả ba payload từ flash sang PSRAM, việc ESP-DL làm khi dựng",
            *(copy(c) for c in CONFIGS),
        ],
        ["CRC32 trên bản chép ở PSRAM (ms)", *(crc(c) for c in CONFIGS)],
    ]


ACCURACY = {
    "detection": [
        ("ap_easy", "AP easy (WIDER val)", 4),
        ("ap_medium", "AP medium", 4),
        ("ap_hard", "AP hard", 4),
        ("ap_ge38px", "**AP mặt ≥ 38 px** (thước chọn)", 4),
    ],
    "antispoof": [
        ("celeba_auc", "**CelebA-Spoof AUC** (thước chọn)", 4),
        ("celeba_eer", "CelebA-Spoof EER", 4),
        ("celeba_apcer", "CelebA-Spoof APCER ở 500‰", 4),
        ("celeba_bpcer", "CelebA-Spoof BPCER ở 500‰", 4),
        ("auc", "87 khung OV5640: AUC", 4),
        ("eer", "87 khung OV5640: EER", 4),
        ("real_min", "87 khung: mặt thật thấp nhất", 3),
        ("attack_max", "87 khung: khung giả cao nhất", 3),
    ],
    "recognition": [
        (
            f"{bench}_{metric}",
            f"**{label} {name}** (thước chọn)"
            if (bench, metric) == ("cfp_fp", "tar3")
            else f"{label} {name}",
            digits,
        )
        for bench, label in (("lfw", "LFW"), ("cfp_fp", "CFP-FP"), ("agedb_30", "AgeDB-30"))
        for metric, name, digits in (
            ("acc", "accuracy", 4),
            ("tar3", "TAR@1e-3", 3),
            ("tar4", "TAR@1e-4", 3),
            ("eer", "EER", 4),
        )
    ],
}
RULERS = {"detection": "ap_ge38px", "antispoof": "celeba_auc", "recognition": "cfp_fp_tar3"}


def kept_and_blocked(metrics: dict) -> str:
    if "real" not in metrics:
        return "—"
    return (
        f"{metrics['real_kept']}/{metrics['real']} · "
        f"{metrics['attacks_blocked']}/{metrics['attacks']}"
    )


def cross_domain_sets(*metrics: dict) -> list[str]:
    """The cross-domain shards the anti-spoof ruler scored, named by their metric prefix."""
    names = {key.rsplit("_", 1)[0] for found in metrics for key in found if key.endswith("_auc")}
    return sorted(names - {"celeba"})


def accuracy_rows(branch: str, scores: dict) -> list[list[str]]:
    espdl = scores.get((branch, "espdl"), {}).get("metrics", {})
    tflite = scores.get((branch, "tflite"), {}).get("metrics", {})
    rows = [
        [label, num(espdl.get(key), digits), num(tflite.get(key), digits)]
        for key, label, digits in ACCURACY[branch]
    ]
    if branch == "antispoof":
        label = "87 khung: thật giữ · giả chặn ở 500‰"
        rows.append([label, kept_and_blocked(espdl), kept_and_blocked(tflite)])
        for name in cross_domain_sets(espdl, tflite):
            for metric in ("auc", "eer"):
                key = f"{name}_{metric}"
                rows.append([f"{name} {metric.upper()}", num(espdl.get(key)), num(tflite.get(key))])
    return rows


def ruler_rows(scores: dict) -> list[list[str]]:
    rows = []
    for branch in BRANCHES:
        key = RULERS[branch]
        label, digits = next((lb, d) for k, lb, d in ACCURACY[branch] if k == key)
        espdl = scores.get((branch, "espdl"), {}).get("metrics", {}).get(key)
        tflite = scores.get((branch, "tflite"), {}).get("metrics", {}).get(key)
        rows.append(
            [f"`{ENTRY[branch]}`: {label.split('**')[1]}", num(espdl, digits), num(tflite, digits)]
        )
    return rows


def spread(found: dict) -> str:
    return (
        f"{found['differ']}/{found['of']} phần tử khác, lệch tối đa {found['widest']} bậc, "
        f"cosine {num(found['cosine'], 6)}"
    )


def match_rows(logs: dict, checked: dict) -> list[list[str]]:
    rows = []
    a, b = logs["tflm"].get("hash"), logs["tflm_ansi"].get("hash")
    if a and b:
        for key in MODELS:
            same = "trùng" if a[key] == b[key] else "**LỆCH**"
            rows.append([f"CRC `{key}`: esp-nn với bản C", f"`{a[key]}` · `{b[key]}`", same])
    host = checked.get("host", {})
    if a and host:
        live = "trùng" if abs(a["live"] - host["spoof_live"]) < 5e-7 else "**LỆCH**"
        pair = f"{num(a['live'], 6)} · {num(host['spoof_live'], 6)}"
        rows.append(["Điểm live: board với TFLite trên máy", pair, live])
        if a["recog"] == host["recog_hash_fused"]:
            recog = "trùng (tổng bình phương làm tròn một lần mỗi bước, như lệnh nhân-cộng)"
        else:
            recog = "trùng" if a["recog"] == host["recog_hash_plain"] else "**LỆCH**"
        pair = f"`{a['recog']}` · `{host['recog_hash_plain']}`"
        rows.append(["CRC embedding: board với TFLite trên máy", pair, recog])
        board = checked.get("boards", {}).get("tflm", {}).get("embedding_vs_host")
        if board:
            rows.append(["Embedding: board với TFLite trên máy", spread(board), "—"])
        if "recog_default_kernels" in host:
            label = "Embedding trên máy: kernel tham chiếu với kernel mặc định của TFLite"
            rows.append([label, spread(host["recog_default_kernels"]), "—"])
    tests = logs["espdl"].get("graph_test", {})
    if tests:
        rows.append(
            ["ESP-DL `model->test()`", ", ".join(f"{k} {v}" for k, v in tests.items()), "—"]
        )
    for config, name in CONFIGS.items():
        got = logs[config].get("summary")
        if got:
            verdict = "đạt" if got["failures"] == 0 else "**HỎNG**"
            rows.append([f"Unity, {name}", f"{got['tests']} ca, {got['failures']} hỏng", verdict])
    return rows


def git_head() -> str:
    found = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "rev-parse", "--short=8", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    return found.stdout.strip() or "?"


def render(args: argparse.Namespace) -> int:
    logs = {config: parse_log(args.out / config / "bench.log") for config in CONFIGS}
    builds = {config: facts(args.out, config) for config in CONFIGS}
    scores = {}
    for path in sorted((args.out / "scores").glob("*.json")):
        found = json.loads(path.read_text(encoding="utf-8"))
        scores[(found["branch"], found["runtime"])] = found
    check_path = args.out / "check.json"
    checked = json.loads(check_path.read_text(encoding="utf-8")) if check_path.is_file() else {}
    sizes = {branch: complexity(tflite_of(branch)) for branch in BRANCHES}
    macs = {ENTRY[branch]: sizes[branch]["macs"] for branch in BRANCHES}
    runs = pick(
        {c: str(logs[c]["setup"]["runs"]) for c in CONFIGS if logs[c].get("setup")} or {"": "?"}
    )
    head = ["", *CONFIGS.values()]

    lines = [
        "# Bảng đối chứng ba runtime trên ba model đang deploy",
        "",
        "> Sinh bằng `make runtime-report` (`ml/bench/runtime_report.py`) từ log `bench_ai`,",
        "> ảnh chụp bản build đã nạp và kết quả chấm trong `ml/artifacts/device/runtime_compare/`,",
        f"> commit `{git_head()}`. Không sửa tay: sửa script hoặc đo lại rồi sinh lại.",
        "> Phương pháp ở KẾ HOẠCH §3 lớp 5 (E9-T51).",
        "",
        "## Tóm tắt",
        "",
        *table(head, summary_rows(logs, builds)),
        "",
        *table(["Thước chọn của thang lượng tử", "ESP-DL", "TFLite / TFLM"], ruler_rows(scores)),
        "",
        "## Môi trường đo",
        "",
        *table(["", "Giá trị"], environment_rows(logs, builds)),
        "",
        "## Model",
        "",
        "Tham số và MAC đếm trên conv, depthwise và FC của file `.tflite`;",
        "ESP-DL chạy cùng kiến trúc.",
        "",
        *table(
            [
                "Nhánh, run trên lock",
                "Đầu vào",
                "Tham số (M)",
                "MAC (M)",
                "ESP-DL (file deploy)",
                "TFLite Q1 (TFLM)",
            ],
            model_rows(sizes),
        ),
    ]
    for when, title in (("idle", "lúc rảnh"), ("under load", "có tải PSRAM của preview")):
        lines += ["", f"## Thời gian, {title} (ms, median / p95 của {runs} lượt)", ""]
        lines += table(head, timing_rows(logs, when))
    lines += ["", "## Tốc độ quy đổi, lúc rảnh", "", *table(head, speed_rows(logs, macs))]
    lines += ["", "### Hệ số tăng tốc", ""]
    lines += table(["", *(label for *_, label in SPEEDUPS)], speedup_rows(logs))
    lines += ["", "## Tài nguyên", "", "### Ảnh app: flash và RAM tĩnh", ""]
    lines += table(head, static_rows(builds))
    lines += ["", "### Thư viện có cỡ khác nhau giữa ba bản build", ""]
    lines += [
        f"Mọi archive chênh từ {vn(ARCHIVE_DIFF_BYTES)} B trở lên, gồm cả thứ runtime kéo theo.",
        "",
    ]
    lines += table(["Archive (flash KB · RAM tĩnh KB)", *CONFIGS.values()], library_rows(builds))
    lines += ["", "### Bộ nhớ khi chạy", "", *table(head, runtime_memory_rows(logs))]
    lines += ["", "## Độ chính xác trên máy, cùng thước với thang lượng tử", ""]
    lines += [
        "Hai cấu hình TFLM chạy cùng một file `.tflite`, nên chung một cột; mục So khớp bên dưới",
        "đo board lệch máy bao nhiêu.",
    ]
    for branch in BRANCHES:
        lines += ["", f"### `{ENTRY[branch]}`", ""]
        lines += table(["", "ESP-DL", "TFLite / TFLM"], accuracy_rows(branch, scores))
    lines += ["", "## So khớp", ""]
    lines += table(["", "Giá trị", "Kết quả"], match_rows(logs, checked) or [["—", "—", "—"]])
    args.report.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{args.report} written")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=WORK, help="where runs and results live")
    commands = parser.add_subparsers(dest="command", required=True)
    imaged = commands.add_parser("image", help="the experimental lock and models_tflm.bin")
    imaged.add_argument("--arena-fast", type=int, default=0, help="detect's arena, bytes")
    imaged.add_argument("--arena-big", type=int, default=0, help="spoof and recog together, bytes")
    scored = commands.add_parser("score", help="one branch on one runtime, to scores/*.json")
    scored.add_argument("--branch", choices=BRANCHES, required=True)
    scored.add_argument("--runtime", choices=("espdl", "tflite"), required=True)
    commands.add_parser("check", help="bench_ai's inputs through the .tflite files, to check.json")
    rendered = commands.add_parser("render", help="docs/measurements/runtime_compare.md")
    rendered.add_argument("--report", type=Path, default=REPORT)
    args = parser.parse_args(argv)
    return {"image": image, "score": score, "check": check, "render": render}[args.command](args)


if __name__ == "__main__":
    raise SystemExit(main())
