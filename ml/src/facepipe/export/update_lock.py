"""Install one exported model as the deployed one and record it in the lock.

Six months on, the only way back from a running kiosk to the run that made
its weights is contracts/models.lock.json (KEHOACH 4.4), so the run id is
checked against a real run directory rather than taken on trust.
"""

import argparse
import json
import shutil
from pathlib import Path

from facepipe.export.pack_models_partition import BRANCH_ENTRY, sha256_of

# The firmware tree names weights per branch, so swapping a rung of the
# KEHOACH 3.7 ladder never renames a file the packer looks for.
DEPLOY_NAME = {
    "detection": "yunet_int8.tflite",
    "antispoof": "minifasnet_int8.tflite",
    "recognition": "mobilefacenet_int8.tflite",
}


def input_shape(model_path: Path) -> tuple[int, int]:
    """Height and width the graph reads, refusing inputs that disagree.

    A partition entry carries one size for the whole model, so a graph whose
    inputs differ cannot be described by KEHOACH 6.2.2 at all.
    """
    from ai_edge_litert.interpreter import Interpreter

    interpreter = Interpreter(model_path=str(model_path))
    sizes = {tuple(int(v) for v in detail["shape"][1:3])
             for detail in interpreter.get_input_details()}
    if len(sizes) != 1:
        raise SystemExit(f"{model_path.name}: inputs disagree on size {sorted(sizes)}")
    height, width = sizes.pop()
    return height, width


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--branch", required=True, choices=sorted(BRANCH_ENTRY))
    parser.add_argument("--model", type=Path, required=True, help="the exported .tflite")
    parser.add_argument("--run-id", required=True, help="<branch>/<run directory name>")
    parser.add_argument("--arena-bytes", type=int, default=0, help="0 until E8-T7 measures it")
    parser.add_argument("--artifacts", type=Path, default=Path("ml/artifacts"))
    parser.add_argument("--lock", type=Path, default=Path("contracts/models.lock.json"))
    parser.add_argument("--models-dir", type=Path, default=Path("firmware/models"))
    args = parser.parse_args(argv)

    branch, _, run_name = args.run_id.partition("/")
    run_dir = args.artifacts / branch / "runs" / run_name
    if branch != args.branch or not run_dir.is_dir():
        raise SystemExit(f"run id must name a directory, and {run_dir} is not one")

    branch_dir = args.models_dir / args.branch
    branch_dir.mkdir(parents=True, exist_ok=True)
    deployed = branch_dir / DEPLOY_NAME[args.branch]
    shutil.copyfile(args.model, deployed)

    height, width = input_shape(deployed)
    digest = sha256_of(deployed)
    meta = {"in_h": height, "in_w": width, "arena_hint": args.arena_bytes,
            "sha256": digest, "run_id": args.run_id}
    (branch_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    lock = json.loads(args.lock.read_text(encoding="utf-8")) if args.lock.is_file() else {}
    lock[args.branch] = {"file": deployed.name, "sha256": digest, "run_id": args.run_id,
                         "arena_bytes": args.arena_bytes}
    ordered = {branch: lock[branch] for branch in BRANCH_ENTRY if branch in lock}
    args.lock.parent.mkdir(parents=True, exist_ok=True)
    args.lock.write_text(json.dumps(ordered, indent=2) + "\n", encoding="utf-8")
    shutil.copyfile(args.lock, args.models_dir / args.lock.name)

    print(f"{args.branch}: {deployed} {height}x{width} sha256 {digest[:12]} run {args.run_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
