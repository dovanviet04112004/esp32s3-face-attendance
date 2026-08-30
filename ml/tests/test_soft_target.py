"""E4-T2: the teacher soft-target shards round-trip and read back by name."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from facepipe.tasks.detection.teacher.export_soft_target import (
    FORMAT_VER,
    SoftTarget,
    SoftTargetStore,
    read_shard,
    shard_path,
    write_shard,
    write_shards,
)


def make_target(name: str, faces: int, seed: int = 0) -> SoftTarget:
    rng = np.random.default_rng(seed)
    return SoftTarget(
        name=name,
        boxes=rng.random((faces, 4), dtype=np.float32) * 100,
        scores=rng.random(faces, dtype=np.float32),
        keypoints=rng.random((faces, 5, 2), dtype=np.float32) * 100,
    )


def test_a_shard_round_trips_every_field(tmp_path: Path) -> None:
    targets = [make_target(f"{i}.jpg", faces=i + 1, seed=i) for i in range(4)]
    write_shard(targets, tmp_path / "s.npz")
    back = read_shard(tmp_path / "s.npz")

    assert list(back) == [t.name for t in targets]
    for original in targets:
        restored = back[original.name]
        assert np.allclose(restored.boxes, original.boxes)
        assert np.allclose(restored.scores, original.scores)
        assert np.allclose(restored.keypoints, original.keypoints)


def test_an_image_with_no_faces_survives_the_round_trip(tmp_path: Path) -> None:
    targets = [make_target("a.jpg", 2), make_target("empty.jpg", 0), make_target("c.jpg", 3)]
    write_shard(targets, tmp_path / "s.npz")
    back = read_shard(tmp_path / "s.npz")

    assert len(back["empty.jpg"].boxes) == 0
    assert len(back["a.jpg"].boxes) == 2
    assert len(back["c.jpg"].boxes) == 3


def test_offsets_keep_each_image_with_its_own_faces(tmp_path: Path) -> None:
    first, second = make_target("a.jpg", 3, seed=1), make_target("b.jpg", 5, seed=2)
    write_shard([first, second], tmp_path / "s.npz")
    back = read_shard(tmp_path / "s.npz")
    assert np.allclose(back["b.jpg"].scores, second.scores)
    assert np.allclose(back["a.jpg"].scores, first.scores)


def test_shards_are_cut_at_the_requested_size(tmp_path: Path) -> None:
    targets = [make_target(f"{i}.jpg", faces=2, seed=i) for i in range(7)]
    stats = write_shards(targets, tmp_path, shard_size=3)
    assert stats == {"images": 7, "faces": 14, "shards": 3}
    assert shard_path(tmp_path, 2).is_file()


def test_the_store_finds_an_image_in_whichever_shard_holds_it(tmp_path: Path) -> None:
    targets = [make_target(f"{i}.jpg", faces=1, seed=i) for i in range(7)]
    write_shards(targets, tmp_path, shard_size=3)

    store = SoftTargetStore(tmp_path)
    assert len(store) == 7 and "6.jpg" in store and "9.jpg" not in store
    assert np.allclose(store["6.jpg"].boxes, targets[6].boxes)
    assert np.allclose(store["0.jpg"].boxes, targets[0].boxes)


def test_an_empty_directory_is_an_error_not_an_empty_store(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="soft target"):
        SoftTargetStore(tmp_path)


def test_a_shard_from_another_format_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "s.npz"
    write_shard([make_target("a.jpg", 1)], path)
    with np.load(path, allow_pickle=False) as payload:
        fields = dict(payload)
    fields["format_ver"] = np.int32(FORMAT_VER + 1)
    np.savez(path, **fields)

    with pytest.raises(ValueError, match="format"):
        read_shard(path)


def test_mismatched_field_lengths_are_caught_at_construction() -> None:
    with pytest.raises(ValueError, match="box"):
        SoftTarget(
            name="a.jpg",
            boxes=np.zeros((2, 4), np.float32),
            scores=np.zeros(3, np.float32),
            keypoints=np.zeros((2, 5, 2), np.float32),
        )


def test_keypoints_keep_five_points_per_face(tmp_path: Path) -> None:
    write_shard([make_target("a.jpg", 4)], tmp_path / "s.npz")
    assert read_shard(tmp_path / "s.npz")["a.jpg"].keypoints.shape == (4, 5, 2)
