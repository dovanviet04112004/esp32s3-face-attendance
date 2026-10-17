"""The three-runtime table of KEHOACH 3 layer 5, from the host's scores and bench_ai's logs.

image packs the lock's runs as Q1 .tflite into an experimental lock and a models image;
score runs one branch's locked .espdl or Q1 .tflite through host_bench and the ladder's ruler;
check replays bench_ai's inputs through the .tflite files and compares the board's outputs;
render writes docs/measurements/runtime_compare.md from all of it.
"""

import argparse
import hashlib
import json
import re
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

import numpy as np

ML_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ML_ROOT.parent
sys.path.insert(0, str(ML_ROOT / "src"))
sys.path.insert(0, str(ML_ROOT / "bench"))

LOCK = REPO_ROOT / "contracts" / "models.lock.json"
WORK = ML_ROOT / "artifacts" / "device" / "runtime_compare"
REPORT = REPO_ROOT / "docs" / "measurements" / "runtime_compare.md"
BRANCHES = ("detection", "antispoof", "recognition")
ENTRY = {"detection": "detect", "antispoof": "spoof", "recognition": "recog"}
CONFIGS = {"espdl": "ESP-DL", "tflm": "TFLM + esp-nn", "tflm_ansi": "TFLM, esp-nn bản C"}
RUNTIME_OF = {"espdl": "espdl", "tflm": "tflite", "tflm_ansi": "tflite"}
# The seed bench_ai.c's psram() fills each branch's input with.
INPUT_SEED = {"detection": 1, "antispoof": 2, "recognition": 4}
LIVE_CLASS = 0
INT8_PEAK = 127.0
NORM_EPS = 1e-10

ANSI = re.compile(r"\x1b\[[0-9;]*m")
TIMING = re.compile(
    r"^(detect|spoof|recog|pass)\s+median\s+(\d+) us\s+p95\s+(\d+) us\s+min\s+(\d+) us"
    r"\s+max\s+(\d+) us\s+mean\s+(\d+) us"
)
ALONE = re.compile(r"^(idle|under load), each branch alone: one face end to end (\d+) us")
INTERLEAVED = re.compile(r"^(idle|under load), interleaved:")
INIT = re.compile(r"^init (\d+) ms, took internal (\d+) KB and psram (\d+) KB")
FREE = re.compile(r"^free after init: internal (\d+) KB, psram (\d+) KB, largest psram block (\d+)")
ARENA = re.compile(r"^arena_(fast|big)\s+(\d+) B of (\d+) KB")
HASH = re.compile(
    r"^hash detect ([0-9a-f]{8}) \((\d+) faces\)\s+spoof ([0-9a-f]{8}) \(live (-?[0-9.]+)\)"
    r"\s+recog ([0-9a-f]{8})"
)
HEAP = re.compile(r"^after (\d+) passes: internal (-?\d+) B, psram (-?\d+) B")
WEIGHTS = re.compile(r"^weights (\d+) KB: copy from flash (\d+) us")
GRAPH_TEST = re.compile(r"^(detect|spoof|recog): (\d+) KB, test (PASS|FAIL)")
SUMMARY = re.compile(r"(\d+) Tests (\d+) Failures (\d+) Ignored")


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
    arena = {"detection": args.arena_fast, "antispoof": args.arena_big, "recognition": args.arena_big}
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


def first_output(branch: str) -> tuple[np.ndarray, float, int]:
    """Output 0 of the branch's .tflite on bench_ai's input, on the kernels TFLM reproduces."""
    import host_bench

    interpreter = host_bench.reference_interpreter(tflite_of(branch))
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


def check(args: argparse.Namespace) -> int:
    logits, scale, zero = first_output("antispoof")
    live = live_score(logits, scale, zero)
    raw, raw_scale, raw_zero = first_output("recognition")
    host = {
        "spoof_live": float(live),
        "spoof_hash": crc32(struct.pack("<f", float(live))),
        "recog_hash_plain": crc32(normalized_int8(raw, raw_scale, raw_zero, fused=False)),
        "recog_hash_fused": crc32(normalized_int8(raw, raw_scale, raw_zero, fused=True)),
    }
    boards = {}
    for config in ("tflm", "tflm_ansi"):
        parsed = parse_log(args.out / f"{config}.log")
        if parsed.get("hash"):
            boards[config] = parsed["hash"]
    result = {"host": host, "boards": boards}
    out = args.out / "check.json"
    out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    return 0


def parse_log(path: Path) -> dict:
    """Every number bench_ai prints, by test case, or an empty dict when the log is missing."""
    if not path.is_file():
        return {}
    found: dict = {"alone": {}, "interleaved": {}, "arena": {}, "graph_test": {}}
    waiting: dict = {}
    section = None
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = ANSI.sub("", raw).strip()
        if hit := INTERLEAVED.match(line):
            section = hit.group(1)
            found["interleaved"][section] = {}
        elif hit := TIMING.match(line):
            keys = ("median", "p95", "min", "max", "mean")
            row = dict(zip(keys, (int(v) for v in hit.groups()[1:]), strict=True))
            if section is not None:
                found["interleaved"][section][hit.group(1)] = row
                section = None if hit.group(1) == "pass" else section
            else:
                waiting[hit.group(1)] = row
        elif hit := ALONE.match(line):
            found["alone"][hit.group(1)] = {**waiting, "sum": int(hit.group(2))}
            waiting = {}
        elif hit := INIT.match(line):
            found["init_ms"], found["internal_kb"], found["psram_kb"] = map(int, hit.groups())
        elif hit := FREE.match(line):
            found["free_internal_kb"], found["free_psram_kb"], found["largest_kb"] = map(
                int, hit.groups()
            )
        elif hit := ARENA.match(line):
            found["arena"][hit.group(1)] = {"used": int(hit.group(2)), "kb": int(hit.group(3))}
        elif hit := HASH.match(line):
            detect, faces, spoof, live, recog = hit.groups()
            found["hash"] = {
                "detect": detect,
                "faces": int(faces),
                "spoof": spoof,
                "live": float(live),
                "recog": recog,
            }
        elif hit := HEAP.match(line):
            found["heap"] = {"passes": int(hit.group(1)), "internal": int(hit.group(2))}
            found["heap"]["psram"] = int(hit.group(3))
        elif hit := WEIGHTS.match(line):
            found["weights"] = {"kb": int(hit.group(1)), "copy_us": int(hit.group(2))}
        elif hit := GRAPH_TEST.match(line):
            found["graph_test"][hit.group(1)] = hit.group(3)
        elif hit := SUMMARY.search(line):
            found["summary"] = {"tests": int(hit.group(1)), "failures": int(hit.group(2))}
    return found


def ms(us: int | None) -> str:
    return "—" if us is None else f"{us / 1000:.1f}".replace(".", ",")


def num(value: float | None, digits: int = 4) -> str:
    return "—" if value is None else f"{value:.{digits}f}".replace(".", ",")


def table(head: list[str], rows: list[list[str]]) -> list[str]:
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    return lines + ["| " + " | ".join(row) + " |" for row in rows]


def timing_rows(logs: dict, when: str) -> list[list[str]]:
    rows = []
    for name in ("detect", "spoof", "recog"):
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


def memory_rows(logs: dict) -> list[list[str]]:
    def cell(config: str, key: str) -> str:
        value = logs[config].get(key)
        return "—" if value is None else str(value)

    def arena(config: str) -> str:
        found = logs[config].get("arena", {})
        if not found or not any(v["used"] for v in found.values()):
            return "không có arena chung"
        return " + ".join(f"{v['used'] // 1024} KB" for v in found.values())

    def heap(config: str) -> str:
        got = logs[config].get("heap")
        return "—" if got is None else f"{got['internal']} B nội, {got['psram']} B PSRAM"

    return [
        ["Thời gian dựng ba model (ms)", *(cell(c, "init_ms") for c in CONFIGS)],
        ["RAM nội lấy khi dựng (KB)", *(cell(c, "internal_kb") for c in CONFIGS)],
        ["PSRAM lấy khi dựng (KB)", *(cell(c, "psram_kb") for c in CONFIGS)],
        ["RAM nội còn trống (KB)", *(cell(c, "free_internal_kb") for c in CONFIGS)],
        ["Arena TFLM đã dùng", *(arena(c) for c in CONFIGS)],
        ["Heap sau 50 lượt so với lượt đầu", *(heap(c) for c in CONFIGS)],
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
        (f"{bench}_{metric}", f"{label} {name}", digits)
        for bench, label in (("lfw", "LFW"), ("cfp_fp", "CFP-FP"), ("agedb_30", "AgeDB-30"))
        for metric, name, digits in (
            ("acc", "accuracy", 4),
            ("tar3", "TAR@1e-3", 3),
            ("tar4", "TAR@1e-4", 3),
            ("eer", "EER", 4),
        )
    ],
}


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


def match_rows(logs: dict, checked: dict) -> list[list[str]]:
    rows = []
    a, b = logs["tflm"].get("hash"), logs["tflm_ansi"].get("hash")
    if a and b:
        for key in ("detect", "spoof", "recog"):
            same = "trùng" if a[key] == b[key] else "**LỆCH**"
            rows.append([f"CRC `{key}`: esp-nn với bản C", f"`{a[key]}` · `{b[key]}`", same])
    host = checked.get("host", {})
    if a and host:
        live = "trùng" if abs(a["live"] - host["spoof_live"]) < 5e-7 else "**LỆCH**"
        pair = f"{a['live']:.6f} · {host['spoof_live']:.6f}"
        rows.append(["Điểm live: board với TFLite trên máy", pair, live])
        if a["recog"] == host["recog_hash_fused"]:
            recog = "trùng (tổng bình phương làm tròn một lần mỗi bước, như lệnh nhân-cộng)"
        else:
            recog = "trùng" if a["recog"] == host["recog_hash_plain"] else "**LỆCH**"
        rows.append(["CRC embedding: board với TFLite trên máy", f"`{a['recog']}`", recog])
    tests = logs["espdl"].get("graph_test", {})
    if tests:
        rows.append(
            ["ESP-DL `model->test()`", ", ".join(f"{k} {v}" for k, v in tests.items()), "—"]
        )
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
    logs = {config: parse_log(args.out / f"{config}.log") for config in CONFIGS}
    scores = {}
    for path in sorted((args.out / "scores").glob("*.json")):
        found = json.loads(path.read_text(encoding="utf-8"))
        scores[(found["branch"], found["runtime"])] = found
    check_path = args.out / "check.json"
    checked = json.loads(check_path.read_text(encoding="utf-8")) if check_path.is_file() else {}

    lines = [
        "# Bảng đối chứng ba runtime trên ba model đang deploy",
        "",
        "> Sinh bằng `make runtime-report` (`ml/bench/runtime_report.py`) từ log `bench_ai`",
        "> và kết quả chấm trong `ml/artifacts/device/runtime_compare/`,",
        f"> commit `{git_head()}`. Không sửa tay: sửa script hoặc đo lại rồi sinh lại.",
        "> Phương pháp ở KẾ HOẠCH §3 lớp 5 (E9-T51).",
        "",
        "## Model",
        "",
    ]
    model_rows = []
    for branch in BRANCHES:
        espdl, tflite = espdl_of(branch), tflite_of(branch)
        model_rows.append(
            [
                f"`{ENTRY[branch]}` `{lock_entries()[branch]['run_id'].split('/', 1)[1]}`",
                f"`{espdl.parent.name}/{espdl.name}` {espdl.stat().st_size // 1024} KB",
                f"`{tflite.name}` {tflite.stat().st_size // 1024} KB",
            ]
        )
    lines += table(["Nhánh, run trên lock", "ESP-DL (file deploy)", "TFLite Q1 (TFLM)"], model_rows)
    head = ["", *CONFIGS.values()]
    for when, title in (("idle", "lúc rảnh"), ("under load", "có tải PSRAM của preview")):
        lines += ["", f"## Thời gian, {title} (ms, median / p95 của 50 lượt)", ""]
        lines += table(head, timing_rows(logs, when))
    lines += ["", "## Bộ nhớ", ""]
    lines += table(head, memory_rows(logs))
    lines += ["", "## Độ chính xác trên máy, cùng thước với thang lượng tử", ""]
    lines += [
        "Hai cấu hình TFLM chạy cùng một file `.tflite`, nên chung một cột; mục So khớp bên dưới",
        "cho thấy board ra đúng số của máy.",
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
    parser.add_argument("--out", type=Path, default=WORK, help="where logs and results live")
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
