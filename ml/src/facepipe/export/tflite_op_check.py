"""List a graph's operators, and check the branch resolver registers them all.

An op the resolver misses makes AllocateTensors reject the graph on the board,
which costs a flash cycle to discover. An op with no ESP-NN kernel still runs,
on the TFLM reference C path, ten to forty times slower (KEHOACH 3 layer 4).
"""

import argparse
import re
from pathlib import Path

# esp-nn carries optimised int8 kernels for these, and only these, on the
# xtensa target; the list tracks esp-nn/src and TFLM's esp_nn integration.
ESP_NN_ACCELERATED = {
    "ADD",
    "AVERAGE_POOL_2D",
    "CONV_2D",
    "DEPTHWISE_CONV_2D",
    "FULLY_CONNECTED",
    "MAX_POOL_2D",
    "MUL",
    "SOFTMAX",
}

# TFLM ships reference kernels for these, so they run but stay on plain C.
TFLM_REFERENCE_ONLY = {
    "CONCATENATION",
    "DEQUANTIZE",
    "LOGISTIC",
    "MEAN",
    "PAD",
    "PRELU",
    "QUANTIZE",
    "RESHAPE",
    "RESIZE_BILINEAR",
    "RESIZE_NEAREST_NEIGHBOR",
    "SLICE",
    "SPLIT",
    "STRIDED_SLICE",
    "SUB",
    "TRANSPOSE",
}


def operators(model_path: Path) -> dict[str, int]:
    """Count how often each operator appears in the graph."""
    from ai_edge_litert.interpreter import Interpreter

    interpreter = Interpreter(model_path=str(model_path))
    interpreter.allocate_tensors()
    counts: dict[str, int] = {}
    for op in interpreter._get_ops_details():
        name = op["op_name"]
        # DELEGATE is the host interpreter handing work to XNNPACK; no such
        # node reaches the board, so counting it would overstate the graph.
        if name == "DELEGATE":
            continue
        counts[name] = counts.get(name, 0) + 1
    return counts


def verdict(counts: dict[str, int]) -> tuple[list[str], list[str], list[str]]:
    """Split the operators into accelerated, reference-only, and unknown."""
    fast = sorted(n for n in counts if n in ESP_NN_ACCELERATED)
    slow = sorted(n for n in counts if n in TFLM_REFERENCE_ONLY)
    unknown = sorted(n for n in counts if n not in ESP_NN_ACCELERATED | TFLM_REFERENCE_ONLY)
    return fast, slow, unknown


OPS_CPP = "firmware/components/ai_engine/src/{branch}/ops.cpp"
_ADD_CALL = re.compile(r"s_resolver\.Add([A-Za-z0-9]+)\(\)")
_TOKEN = re.compile(r"[A-Z][a-z]*|\d+[A-Z]*")


def builtin_name(add_method: str) -> str:
    """The BuiltinOperator a MicroMutableOpResolver::AddXxx() registers.

    TFLM names the two consistently, so the mapping is derived rather than
    tabulated; tests/test_export_op_check.py holds it against TFLM's own header.
    """
    return "_".join(_TOKEN.findall(add_method)).upper()


def resolver_ops(ops_cpp: Path) -> set[str]:
    """Every builtin the branch resolver registers, read from its own source."""
    text = ops_cpp.read_text(encoding="utf-8")
    return {builtin_name(name) for name in _ADD_CALL.findall(text)}


def repo_root(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        if (candidate / ".git").exists():
            return candidate
    raise FileNotFoundError(f"no repository root above {start}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True, help="a .tflite file")
    parser.add_argument("--out", type=Path, help="where to write the report")
    parser.add_argument(
        "--branch",
        choices=("detection", "antispoof", "recognition"),
        help="compare against this branch's ops.cpp and fail on anything it misses",
    )
    args = parser.parse_args(argv)

    counts = operators(args.model)
    fast, slow, unknown = verdict(counts)
    lines = [f"{args.model.name}", f"{sum(counts.values())} operator instance(s)", ""]
    for title, group in (("esp-nn", fast), ("tflm reference", slow), ("UNKNOWN", unknown)):
        for name in group:
            lines.append(f"{title:16s} {name:28s} x{counts[name]}")

    missing: set[str] = set()
    if args.branch is not None:
        ops_cpp = repo_root(Path(__file__).resolve()) / OPS_CPP.format(branch=args.branch)
        registered = resolver_ops(ops_cpp)
        missing = set(counts) - registered
        spare = registered - set(counts)
        lines.append("")
        lines.append(f"resolver {args.branch}: {len(registered)} builtin(s) from {ops_cpp.name}")
        for name in sorted(missing):
            lines.append(f"{'NOT REGISTERED':16s} {name:28s} x{counts[name]}")
        for name in sorted(spare):
            lines.append(f"{'never reached':16s} {name:28s}")

    report = "\n".join(lines)
    print(report)
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(report + "\n", encoding="utf-8")
    return 1 if unknown or missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
