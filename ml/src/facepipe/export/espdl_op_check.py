"""List a .espdl graph's operators, and check ESP-DL registers a module for every one.

ESP-DL has no reference kernel to fall back to: an op without a module makes
dl::Model stop part-way through its load, so the graph has no outputs and the
board reads a null tensor (KEHOACH 3 layer 1). The registered set is read from
the esp-dl the firmware builds against, never copied here.
"""

from __future__ import annotations

import argparse
import hashlib
import re
from collections import Counter
from pathlib import Path

from facepipe.export.tflite_op_check import repo_root

MAGIC = b"EDL2"
HEADER_BYTES = 16
CREATOR_HPP = ("firmware/managed_components/espressif__esp-dl/dl/module/include/"
               "dl_module_creator.hpp")
_REGISTER = re.compile(r'register_module\(\s*"([A-Za-z0-9_]+)"')


def graph(path: Path):
    """The FlatBuffer graph behind the 16-byte EDL2 header; encrypted files are refused."""
    from esp_ppq.parser.espdl.FlatBuffers.Dl.Model import Model

    data = path.read_bytes()
    if data[:4] != MAGIC or int.from_bytes(data[4:8], "little") != 0:
        raise ValueError(f"{path.name}: not a plain EDL2 file")
    return Model.GetRootAs(data[HEADER_BYTES:], 0).Graph()


def _text(value: bytes | str) -> str:
    return value.decode() if isinstance(value, bytes) else value


def operators(path: Path) -> Counter[str]:
    g = graph(path)
    return Counter(_text(g.Node(i).OpType()) for i in range(g.NodeLength()))


def input_shape(path: Path) -> list[int]:
    """The first input's dimensions, NHWC as ESP-DL lays tensors out."""
    from esp_ppq.parser.espdl.FlatBuffers.Dl.TensorTypeAndShape import TensorTypeAndShape

    info = graph(path).Input(0).ValueInfoType()
    tensor = TensorTypeAndShape()
    tensor.Init(info.Value().Bytes, info.Value().Pos)
    shape = tensor.Shape()
    return [int(shape.Dim(i).Value().DimValue()) for i in range(shape.DimLength())]


def content_digest(path: Path) -> str:
    """A hash of what the file computes: operators and every initializer's bytes and exponents.

    ESP-PPQ numbers its variables and draws its test vector anew on each export, so
    two exports of one run differ byte for byte while carrying the same model.
    """
    g = graph(path)
    records = []
    for i in range(g.InitializerLength()):
        tensor = g.Initializer(i)
        chunks = range(tensor.RawDataLength())
        raw = b"".join(bytes(tensor.RawData(j).BytesAsNumpy()) for j in chunks)
        exponents = tensor.ExponentsAsNumpy().tobytes() if tensor.ExponentsLength() else b""
        records.append(hashlib.sha256(raw + b"|" + exponents + b"|"
                                      + tensor.DimsAsNumpy().tobytes()).hexdigest())
    ops = ",".join(f"{name}x{count}" for name, count in sorted(operators(path).items()))
    return hashlib.sha256(("|".join(sorted(records)) + "#" + ops).encode()).hexdigest()


def registered(creator_hpp: Path) -> set[str]:
    """Every op name ESP-DL's module creator maps to a module."""
    return set(_REGISTER.findall(creator_hpp.read_text(encoding="utf-8")))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True, help="a .espdl file")
    parser.add_argument("--creator", type=Path, default=None,
                        help="dl_module_creator.hpp; defaults to the firmware's managed copy")
    parser.add_argument("--out", type=Path, help="where to write the report")
    args = parser.parse_args(argv)

    creator = args.creator or repo_root(Path(__file__).resolve()) / CREATOR_HPP
    if not creator.is_file():
        raise SystemExit(f"{creator} is missing; build the firmware once so the component "
                         "manager fetches esp-dl")
    known = registered(creator)
    counts = operators(args.model)
    missing = sorted(set(counts) - known)
    lines = [args.model.name, f"{sum(counts.values())} operator instance(s), "
             f"{len(known)} module(s) in {creator.name}", ""]
    for name in sorted(counts):
        status = "NO MODULE" if name in missing else "esp-dl"
        lines.append(f"{status:16s} {name:28s} x{counts[name]}")

    report = "\n".join(lines)
    print(report)
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(report + "\n", encoding="utf-8")
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
