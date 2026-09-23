"""Install one exported model as the deployed one and record it in the lock.

Six months on, the only way back from a running kiosk to the run that made
its weights is contracts/models.lock.json (KEHOACH 4.4), so the run id is
checked against a real run directory rather than taken on trust.
"""

import argparse
import json
import shutil
from pathlib import Path

from facepipe.export import espdl_op_check, tflite_op_check
from facepipe.export.pack_models_partition import BRANCH_ENTRY, payload_runtime, sha256_of

# The firmware tree names weights per branch and runtime, so swapping a rung of
# the KEHOACH 3.7 ladder never renames a file the packer looks for.
DEPLOY_NAME = {
    "tflm": {
        "detection": "yunet_int8.tflite",
        "antispoof": "minifasnet_int8.tflite",
        "recognition": "mobilefacenet_int8.tflite",
    },
    "espdl": {
        "detection": "yunet_s8.espdl",
        "antispoof": "minifasnet_s8.espdl",
        "recognition": "mobilefacenet_s8.espdl",
    },
}


def input_shape(model_path: Path) -> tuple[int, int]:
    """Height and width the graph reads, refusing inputs that disagree.

    A partition entry carries one size for the whole model, so a graph whose
    inputs differ cannot be described by KEHOACH 6.2.2 at all.
    """
    if payload_runtime(model_path) == "espdl":
        _batch, height, width, _channels = espdl_op_check.input_shape(model_path)
        return height, width
    from ai_edge_litert.interpreter import Interpreter

    interpreter = Interpreter(model_path=str(model_path))
    sizes = {
        tuple(int(v) for v in detail["shape"][1:3]) for detail in interpreter.get_input_details()
    }
    if len(sizes) != 1:
        raise SystemExit(f"{model_path.name}: inputs disagree on size {sorted(sizes)}")
    height, width = sizes.pop()
    return height, width


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--branch", required=True, choices=sorted(BRANCH_ENTRY))
    parser.add_argument("--model", type=Path, required=True, help="the exported .tflite or .espdl")
    parser.add_argument("--run-id", required=True, help="<branch>/<run directory name>")
    parser.add_argument(
        "--arena-bytes",
        type=int,
        required=True,
        help="bytes of the arena the branch runs in, 0 only while nobody has measured it",
    )
    parser.add_argument("--artifacts", type=Path, default=Path("ml/artifacts"))
    parser.add_argument("--lock", type=Path, default=Path("contracts/models.lock.json"))
    parser.add_argument("--models-dir", type=Path, default=Path("firmware/models"))
    parser.add_argument(
        "--creator", type=Path, default=None, help="dl_module_creator.hpp for the ESP-DL op check"
    )
    args = parser.parse_args(argv)
    runtime = payload_runtime(args.model)
    if runtime == "espdl" and args.arena_bytes != 0:
        raise SystemExit(
            "an .espdl entry carries arena_bytes 0: ESP-DL sizes its own memory (KEHOACH 3.8)"
        )

    branch, _, run_name = args.run_id.partition("/")
    run_dir = args.artifacts / branch / "runs" / run_name
    if branch != args.branch or not run_dir.is_dir():
        raise SystemExit(f"run id must name a directory, and {run_dir} is not one")

    # A graph the runtime cannot build fails only on the board, a whole flash
    # cycle later, so it must not reach firmware/models/ at all.
    if runtime == "espdl":
        creator = ["--creator", str(args.creator)] if args.creator is not None else []
        checked = espdl_op_check.main(["--model", str(args.model), *creator])
    else:
        checked = tflite_op_check.main(["--model", str(args.model), "--branch", args.branch])
    if checked != 0:
        raise SystemExit(f"{args.model}: {runtime} cannot build every operator of this graph")

    branch_dir = args.models_dir / args.branch
    branch_dir.mkdir(parents=True, exist_ok=True)
    deployed = branch_dir / DEPLOY_NAME[runtime][args.branch]
    shutil.copyfile(args.model, deployed)

    height, width = input_shape(deployed)
    digest = sha256_of(deployed)
    meta = {
        "in_h": height,
        "in_w": width,
        "arena_hint": args.arena_bytes,
        "sha256": digest,
        "run_id": args.run_id,
    }
    (branch_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    lock = json.loads(args.lock.read_text(encoding="utf-8")) if args.lock.is_file() else {}
    lock[args.branch] = {
        "file": deployed.name,
        "sha256": digest,
        "run_id": args.run_id,
        "arena_bytes": args.arena_bytes,
    }
    ordered = {branch: lock[branch] for branch in BRANCH_ENTRY if branch in lock}
    args.lock.parent.mkdir(parents=True, exist_ok=True)
    args.lock.write_text(json.dumps(ordered, indent=2) + "\n", encoding="utf-8")
    mirror = args.models_dir / args.lock.name
    if mirror.resolve() != args.lock.resolve():
        shutil.copyfile(args.lock, mirror)

    print(
        f"{args.branch}: {deployed} {height}x{width} {runtime} sha256 {digest[:12]} "
        f"run {args.run_id}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
