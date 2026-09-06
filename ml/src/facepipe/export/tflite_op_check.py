"""List a graph's operators and say which ones ESP-NN accelerates.

An op with no ESP-NN kernel still runs, on the TFLM reference C path, ten to
forty times slower (KEHOACH 3.9). Finding one here costs a minute; finding it
after the engine is built costs a rebuild of the branch.
"""

import argparse
import json
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
    for op in interpreter._get_ops_details():  # noqa: SLF001  the only public-ish route
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True, help="a .tflite file")
    parser.add_argument("--out", type=Path, help="where to write the report")
    args = parser.parse_args(argv)

    counts = operators(args.model)
    fast, slow, unknown = verdict(counts)
    lines = [f"{args.model.name}", f"{sum(counts.values())} operator instance(s)", ""]
    for title, group in (("esp-nn", fast), ("tflm reference", slow), ("UNKNOWN", unknown)):
        for name in group:
            lines.append(f"{title:16s} {name:28s} x{counts[name]}")
    report = "\n".join(lines)
    print(report)
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(report + "\n", encoding="utf-8")
    return 1 if unknown else 0


if __name__ == "__main__":
    raise SystemExit(main())
