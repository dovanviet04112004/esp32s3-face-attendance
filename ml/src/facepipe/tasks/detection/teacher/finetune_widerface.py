"""Fine-tune YOLO26m-pose from COCO person-pose onto WIDER FACE.

Two things change at once: one class instead of eighty, and five keypoints
instead of seventeen. Ultralytics rebuilds the head from the dataset yaml, so
kpt_shape and nc there are what actually decide the architecture.

Images are symlinked rather than copied. WIDER FACE train is 1.4 GB and lives on
the data drive; a second copy on the WSL disk would not fit.

Usage:
    python -m facepipe.tasks.detection.teacher.finetune_widerface \\
        --cfg configs/detection/teacher_yolo26m_pose.yaml
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Iterable
from pathlib import Path

import yaml

from facepipe.core.config import load_config
from facepipe.core.run_dir import create_run_dir

from ..student.head import LANDMARK_COUNT

TRAIN_LIST = "train.txt"
VAL_LIST = "landmark_val.txt"
FACE_CLASS = 0


def read_split(path: Path) -> set[str]:
    return {line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}


def unit(value: float) -> float:
    """Clamp a normalised coordinate into [0, 1].

    WIDER FACE annotates faces that run off the edge of the frame, so a few
    landmarks land outside it. Ultralytics drops the whole label file when a
    keypoint exceeds 1.01, taking every other face in that image with it;
    clamping keeps the image and moves the point to the border it sits behind.
    """
    return min(1.0, max(0.0, value))


def to_yolo_line(annotation: dict, width: int, height: int) -> str:
    """One label row: class, normalised box centre and size, then five points.

    A landmark that WIDER never labelled is written with visibility 0 rather
    than dropped, because the row length is fixed and Ultralytics reads it
    positionally.
    """
    x, y, w, h = annotation["bbox"]
    parts = [
        f"{FACE_CLASS}",
        f"{unit((x + w / 2) / width):.6f}",
        f"{unit((y + h / 2) / height):.6f}",
        f"{unit(w / width):.6f}",
        f"{unit(h / height):.6f}",
    ]
    keypoints = annotation.get("keypoints") or [0.0] * (LANDMARK_COUNT * 3)
    for index in range(LANDMARK_COUNT):
        px, py, visible = keypoints[index * 3 : index * 3 + 3]
        parts += [f"{unit(px / width):.6f}", f"{unit(py / height):.6f}", f"{int(visible)}"]
    return " ".join(parts)


def write_yolo_dataset(coco_path: Path, images_root: Path, split_dir: Path, out: Path) -> dict:
    """Lay out images/ and labels/ for each split and return the counts."""
    payload = json.loads(coco_path.read_text(encoding="utf-8"))
    by_image: dict[int, list[dict]] = {}
    for annotation in payload["annotations"]:
        by_image.setdefault(annotation["image_id"], []).append(annotation)

    members = {"train": read_split(split_dir / TRAIN_LIST), "val": read_split(split_dir / VAL_LIST)}
    counts = {"train": 0, "val": 0, "skipped": 0}

    for split in members:
        for kind in ("images", "labels"):
            (out / kind / split).mkdir(parents=True, exist_ok=True)

    for image in payload["images"]:
        name = image["file_name"]
        split = next((s for s, listed in members.items() if name in listed), None)
        if split is None:
            counts["skipped"] += 1
            continue
        stem = name.replace("/", "__")
        link = out / "images" / split / stem
        if not link.is_symlink():
            link.symlink_to((images_root / name).resolve())
        rows = [
            to_yolo_line(a, image["width"], image["height"]) for a in by_image.get(image["id"], [])
        ]
        (out / "labels" / split / f"{Path(stem).stem}.txt").write_text(
            "\n".join(rows) + ("\n" if rows else ""), encoding="utf-8"
        )
        counts[split] += 1
    return counts


def write_data_yaml(out: Path, names: Iterable[str] = ("face",)) -> Path:
    path = out / "data.yaml"
    path.write_text(
        yaml.safe_dump(
            {
                "path": str(out.resolve()),
                "train": "images/train",
                "val": "images/val",
                "kpt_shape": [LANDMARK_COUNT, 3],
                "flip_idx": [1, 0, 2, 4, 3],
                "names": {index: name for index, name in enumerate(names)},
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cfg", type=Path, required=True)
    parser.add_argument("--set", nargs="*", default=[], metavar="KEY=VALUE")
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args(argv)

    cfg = load_config(args.cfg, args.set)
    params = cfg.teacher.params
    dataset = Path(params["yolo_dataset"])

    counts = write_yolo_dataset(
        Path(params["coco"]), Path(params["images"]), Path(params["split_dir"]), dataset
    )
    data_yaml = write_data_yaml(dataset)
    print(f"{dataset}: train {counts['train']} / val {counts['val']}, skipped {counts['skipped']}")
    if args.prepare_only:
        return 0

    from ultralytics import YOLO

    # Absolute on purpose: Ultralytics resolves a relative project under its own
    # runs_dir, which would put the weights outside the run directory (CLAUDE.md 4.2).
    run = create_run_dir(cfg)
    print(f"run: {run.path}")
    YOLO(str(cfg.teacher.ckpt)).train(
        data=str(data_yaml.resolve()),
        epochs=cfg.train.epochs,
        batch=cfg.data.batch_size,
        imgsz=cfg.teacher.input_hw[1],
        project=str(run.path.resolve()),
        name="ultralytics",
        seed=cfg.run.seed,
        deterministic=cfg.run.deterministic,
        exist_ok=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
