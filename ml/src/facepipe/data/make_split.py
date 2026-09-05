"""Deterministic split generation with a SPLIT.md that records how to redo it.

Two rules it exists to enforce (KEHOACH 1.3). Anti-spoof and recognition splits
are identity-disjoint: a person in both train and val turns the metric into a
memory test. Calibration and device test sets never intersect: calibrating INT8
on the images used to report accuracy makes any number look good.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path

SPLIT_ROOT = Path("data/splits")
DEFAULT_SEED = 42
CALIB_PER_BRANCH = 100

TASK_VERSIONS = {
    "detection": "v1",
    "antispoof": "v1_upstream",
    "recognition": "v1_identity_disjoint",
    "device": "v1",
}


@dataclass
class SplitResult:
    """Where a split landed and what it contains."""

    task: str
    out_dir: Path
    parts: dict[str, list[str]]
    digests: dict[str, str]
    rule: str
    seed: int

    @property
    def counts(self) -> dict[str, int]:
        return {name: len(items) for name, items in self.parts.items()}


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def partition(items: Sequence[str], ratios: Sequence[float], seed: int) -> list[list[str]]:
    """Shuffle once with a fixed seed, then cut at the ratio boundaries.

    Sorting first makes the result independent of filesystem ordering, so two
    machines with the same input produce byte-identical splits.
    """
    if abs(sum(ratios) - 1.0) > 1e-6:
        raise ValueError(f"ratios must sum to 1, got {ratios} summing to {sum(ratios)}")
    ordered = sorted(set(items))
    random.Random(seed).shuffle(ordered)

    out: list[list[str]] = []
    start = 0
    for index, ratio in enumerate(ratios):
        if index == len(ratios) - 1:
            out.append(ordered[start:])
            break
        stop = start + round(len(ordered) * ratio)
        out.append(ordered[start:stop])
        start = stop
    return out


def read_lines(path: Path) -> list[str]:
    return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def identities_from_listing(path: Path) -> list[str]:
    """Take the first path component as the identity, the layout insightface uses."""
    return sorted({line.split("/", 1)[0] for line in read_lines(path)})


def images_from_coco(path: Path) -> list[str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return [image["file_name"] for image in payload["images"]]


def read_device_manifest(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def images_with_landmarks(path: Path) -> tuple[list[str], list[str]]:
    """Split a COCO file into images that carry landmarks and images that do not."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    annotated = {
        ann["image_id"] for ann in payload["annotations"] if ann.get("num_keypoints", 0) > 0
    }
    with_lm, without = [], []
    for image in payload["images"]:
        (with_lm if image["id"] in annotated else without).append(image["file_name"])
    return with_lm, without


def build_detection(source: Path, seed: int, ratios: Sequence[float]) -> dict[str, list[str]]:
    """Hold out a landmark evaluation set, taken from train.

    The upstream val split carries boxes but no landmarks, so NMSE has to be
    measured on images held out of train. Only images that actually carry
    landmarks are eligible, and they leave the training list entirely.
    """
    with_lm, without = images_with_landmarks(source)
    keep, held_out = partition(with_lm, ratios, seed)
    return {"train.txt": sorted(keep + without), "landmark_val.txt": sorted(held_out)}


def build_antispoof_upstream(crops_root: Path) -> dict[str, list[str]]:
    """List the crops of each upstream split.

    The CelebA-Spoof mirror carries no identity labels, so identity-disjointness
    cannot be checked here. The upstream train/valid/test division is the only
    separation available, and reshuffling it would silently break the rule.
    """
    scale_dir = crops_root / "img_1x"
    names = {"train": "train_ids.txt", "valid": "val_ids.txt", "test": "test_ids.txt"}
    parts: dict[str, list[str]] = {}
    for split, filename in names.items():
        entries = [
            str(path.relative_to(scale_dir))
            for label in ("live", "spoof")
            for path in sorted((scale_dir / split / label).glob("*.jpg"))
        ]
        parts[filename] = entries
    return parts


def build_identity_disjoint(
    source: Path, seed: int, ratios: Sequence[float], names: Sequence[str]
) -> dict[str, list[str]]:
    """Split on identity, never on sample."""
    identities = identities_from_listing(source)
    parts = partition(identities, ratios, seed)
    return dict(zip(names, parts, strict=True))


def build_device(
    manifest: Path, seed: int, calib_per_branch: int = CALIB_PER_BRANCH
) -> dict[str, list[str]]:
    """Carve three disjoint calibration sets, and leave everything else for test.

    Calibration images are drawn from the live captures only: a spoof frame in
    the PTQ set skews the activation ranges towards the attack distribution.
    """
    rows = read_device_manifest(manifest)
    live = sorted({row["file"] for row in rows if row.get("is_spoof", "0") in ("0", "false", "")})
    everything = sorted({row["file"] for row in rows})

    needed = calib_per_branch * 3
    if len(live) < needed:
        raise ValueError(
            f"{manifest}: {len(live)} live image(s) but calibration needs {needed}. "
            "Capture more before splitting."
        )

    shuffled = list(live)
    random.Random(seed).shuffle(shuffled)
    pool = shuffled[:needed]
    calib = {
        "calib_det.txt": sorted(pool[0:calib_per_branch]),
        "calib_spoof.txt": sorted(pool[calib_per_branch : 2 * calib_per_branch]),
        "calib_recog.txt": sorted(pool[2 * calib_per_branch : 3 * calib_per_branch]),
    }
    used = set(pool)
    return {**calib, "test_device.txt": sorted(f for f in everything if f not in used)}


def check_disjoint(parts: dict[str, list[str]], groups: Iterable[Sequence[str]]) -> None:
    """Raise when two parts that must not intersect do."""
    for group in groups:
        seen: dict[str, str] = {}
        for name in group:
            for item in parts.get(name, []):
                if item in seen:
                    raise ValueError(
                        f"{item!r} appears in both {seen[item]} and {name}; "
                        "the split is not disjoint"
                    )
                seen[item] = name


def write_split(
    task: str,
    parts: dict[str, list[str]],
    rule: str,
    seed: int,
    command: str,
    split_root: Path = SPLIT_ROOT,
) -> SplitResult:
    """Write every part plus the SPLIT.md that makes it reproducible."""
    out_dir = split_root / task / TASK_VERSIONS[task]
    out_dir.mkdir(parents=True, exist_ok=True)

    digests: dict[str, str] = {}
    for name, items in parts.items():
        text = "\n".join(items) + ("\n" if items else "")
        (out_dir / name).write_text(text, encoding="utf-8")
        digests[name] = sha256_text(text)

    result = SplitResult(task, out_dir, parts, digests, rule, seed)
    _write_split_md(result, command)
    return result


def _write_split_md(result: SplitResult, command: str) -> None:
    digest_lines = "\n".join(
        f"          {name} = {digest}" for name, digest in sorted(result.digests.items())
    )
    count_lines = " / ".join(f"{name} {count}" for name, count in sorted(result.counts.items()))
    text = (
        f"Quy tac:  {result.rule}\n"
        f"Sinh bang: {command}\n"
        f"Ngay:     {date.today().isoformat()}\n"
        f"sha256:\n{digest_lines}\n"
        f"So luong: {count_lines}\n"
    )
    (result.out_dir / "SPLIT.md").write_text(text, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", required=True, choices=sorted(TASK_VERSIONS))
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--split-root", type=Path, default=SPLIT_ROOT)
    parser.add_argument("--calib-per-branch", type=int, default=CALIB_PER_BRANCH)
    args = parser.parse_args(argv)

    command = f"python -m facepipe.data.make_split --task {args.task} --seed {args.seed}"

    if args.task == "detection":
        parts = build_detection(args.source, args.seed, (0.9, 0.1))
        rule = (
            f"landmark_val cat tu train, seed={args.seed}, ti le 90/10 tren anh co landmark; "
            "val goc cua WIDER khong co landmark nen khong dung do NMSE"
        )
        disjoint = [("train.txt", "landmark_val.txt")]
    elif args.task == "antispoof":
        parts = build_antispoof_upstream(args.source)
        rule = (
            "giu nguyen chia train/valid/test cua upstream; mirror khong co nhan "
            "identity nen khong tu kiem identity-disjoint duoc"
        )
        disjoint = [("train_ids.txt", "val_ids.txt", "test_ids.txt")]
    elif args.task == "recognition":
        parts = build_identity_disjoint(
            args.source, args.seed, (0.9, 0.1), ("train_ids.txt", "val_ids.txt")
        )
        rule = f"identity-disjoint, seed={args.seed}, ti le 90/10 theo person_id"
        disjoint = [("train_ids.txt", "val_ids.txt")]
    else:
        parts = build_device(args.source, args.seed, args.calib_per_branch)
        rule = (
            f"calib lay tu anh live, seed={args.seed}, "
            f"{args.calib_per_branch} anh moi nhanh, phan con lai la test_device"
        )
        disjoint = [
            ("calib_det.txt", "calib_spoof.txt", "calib_recog.txt", "test_device.txt"),
        ]

    check_disjoint(parts, disjoint)
    result = write_split(args.task, parts, rule, args.seed, command, args.split_root)
    print(f"{result.out_dir}: " + ", ".join(f"{k} {v}" for k, v in sorted(result.counts.items())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
