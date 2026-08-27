"""E3-T6: splits stay identity-disjoint and calibration never touches the test set.

Both failures this guards against are silent. A person in train and val makes
recognition look better than it is; a calibration image in test_device makes
every INT8 number look good.
"""

from __future__ import annotations

import csv
from pathlib import Path

import pytest

from facepipe.data.make_split import (
    build_device,
    build_identity_disjoint,
    check_disjoint,
    partition,
    write_split,
)


def write_listing(path: Path, entries: list[str]) -> Path:
    path.write_text("\n".join(entries) + "\n", encoding="utf-8")
    return path


def write_device_manifest(path: Path, rows: list[dict[str, str]]) -> Path:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["file", "person_id", "is_spoof"])
        writer.writeheader()
        writer.writerows(rows)
    return path


def test_partition_is_deterministic() -> None:
    items = [f"id_{i:04d}" for i in range(200)]
    first = partition(items, (0.8, 0.2), seed=42)
    second = partition(items, (0.8, 0.2), seed=42)
    assert first == second


def test_partition_ignores_input_order() -> None:
    items = [f"id_{i:04d}" for i in range(200)]
    shuffled = list(reversed(items))
    assert partition(items, (0.8, 0.2), seed=7) == partition(shuffled, (0.8, 0.2), seed=7)


def test_partition_rejects_ratios_that_do_not_sum_to_one() -> None:
    with pytest.raises(ValueError, match="sum to 1"):
        partition(["a", "b"], (0.5, 0.2), seed=1)


def test_partition_keeps_every_item_exactly_once() -> None:
    items = [f"id_{i:04d}" for i in range(97)]
    parts = partition(items, (0.8, 0.1, 0.1), seed=3)
    flat = [item for part in parts for item in part]
    assert sorted(flat) == sorted(items)
    assert len(flat) == len(set(flat))


def test_identity_split_shares_no_person(tmp_path: Path) -> None:
    listing = write_listing(
        tmp_path / "train.txt",
        [f"person{p:03d}/img{i}.jpg" for p in range(60) for i in range(4)],
    )
    parts = build_identity_disjoint(
        listing,
        seed=42,
        ratios=(0.8, 0.1, 0.1),
        names=("train_ids.txt", "val_ids.txt", "test_ids.txt"),
    )
    check_disjoint(parts, [tuple(parts)])
    assert set(parts["train_ids.txt"]).isdisjoint(parts["val_ids.txt"])
    assert sum(len(v) for v in parts.values()) == 60


def test_check_disjoint_is_red_when_identities_are_mixed() -> None:
    mixed = {
        "train_ids.txt": ["person001", "person002"],
        "val_ids.txt": ["person002", "person003"],
    }
    with pytest.raises(ValueError, match="not disjoint"):
        check_disjoint(mixed, [("train_ids.txt", "val_ids.txt")])


def test_device_split_keeps_calibration_out_of_test(tmp_path: Path) -> None:
    rows = [
        {"file": f"images/s1_{i:04d}.jpg", "person_id": f"p{i % 20}", "is_spoof": "0"}
        for i in range(400)
    ]
    rows += [
        {"file": f"images/s2_{i:04d}.jpg", "person_id": f"p{i % 20}", "is_spoof": "1"}
        for i in range(100)
    ]
    manifest = write_device_manifest(tmp_path / "manifest.csv", rows)

    parts = build_device(manifest, seed=42, calib_per_branch=100)
    check_disjoint(parts, [tuple(parts)])

    calib = (
        set(parts["calib_det.txt"]) | set(parts["calib_spoof.txt"]) | set(parts["calib_recog.txt"])
    )
    assert len(calib) == 300
    assert calib.isdisjoint(parts["test_device.txt"])
    assert len(parts["test_device.txt"]) == 200


def test_calibration_never_draws_a_spoof_frame(tmp_path: Path) -> None:
    rows = [
        {"file": f"images/live_{i:04d}.jpg", "person_id": "p0", "is_spoof": "0"} for i in range(300)
    ]
    rows += [
        {"file": f"images/spoof_{i:04d}.jpg", "person_id": "p0", "is_spoof": "1"}
        for i in range(300)
    ]
    manifest = write_device_manifest(tmp_path / "manifest.csv", rows)
    parts = build_device(manifest, seed=1, calib_per_branch=100)
    for name in ("calib_det.txt", "calib_spoof.txt", "calib_recog.txt"):
        assert all("live_" in item for item in parts[name]), name


def test_device_split_refuses_when_there_are_too_few_live_images(tmp_path: Path) -> None:
    rows = [
        {"file": f"images/live_{i:04d}.jpg", "person_id": "p0", "is_spoof": "0"} for i in range(50)
    ]
    manifest = write_device_manifest(tmp_path / "manifest.csv", rows)
    with pytest.raises(ValueError, match="calibration needs 300"):
        build_device(manifest, seed=1, calib_per_branch=100)


def test_split_md_records_seed_command_and_digests(tmp_path: Path) -> None:
    parts = {"train_ids.txt": ["p1", "p2"], "val_ids.txt": ["p3"]}
    result = write_split(
        "recognition",
        parts,
        rule="identity-disjoint, seed=42, ti le 90/10 theo person_id",
        seed=42,
        command="python -m facepipe.data.make_split --task recognition --seed 42",
        split_root=tmp_path,
    )
    text = (result.out_dir / "SPLIT.md").read_text(encoding="utf-8")
    assert "seed=42" in text
    assert "make_split --task recognition" in text
    for name, digest in result.digests.items():
        assert name in text
        assert digest in text
    assert result.counts == {"train_ids.txt": 2, "val_ids.txt": 1}


def test_split_files_are_byte_stable_across_runs(tmp_path: Path) -> None:
    parts = {"train_ids.txt": ["p2", "p1"], "val_ids.txt": ["p3"]}
    first = write_split("recognition", parts, "r", 42, "cmd", tmp_path / "a")
    second = write_split("recognition", parts, "r", 42, "cmd", tmp_path / "b")
    assert first.digests == second.digests
