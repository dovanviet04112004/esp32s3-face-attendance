"""E6: the split the branch is measured on, and the augmentation that guards it."""

from __future__ import annotations

import io
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from facepipe.data.prepare.images_to_wds import ShardWriter
from facepipe.tasks.antispoof.data import (
    QUALITY_RANGE,
    SpoofSample,
    SpoofShardDataset,
    recompress,
    requantise,
    resolve_spec,
    resolve_splits,
)

SIZE = 80


def crop_bytes(shade: int, size: int = SIZE) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (size, size), (shade, shade // 2, 255 - shade)).save(buffer, format="JPEG")
    return buffer.getvalue()


def write_split(root: Path, records: int, shard_size: int = 4) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    with ShardWriter(root, shard_size=shard_size) as writer:
        for index in range(records):
            writer.add(
                {
                    "tight.jpg": crop_bytes(10 + index),
                    "wide.jpg": crop_bytes(200 - index),
                    "json": json.dumps({"name": f"f{index}", "label": index % 2}).encode(),
                }
            )
    return root


def textured(seed: int = 0) -> np.ndarray:
    """Noise, because a flat colour survives any JPEG quality unchanged."""
    return np.random.default_rng(seed).integers(0, 256, (SIZE, SIZE, 3), dtype=np.uint8)


def test_a_bare_name_takes_every_shard_of_that_split(tmp_path: Path) -> None:
    write_split(tmp_path / "test", records=12, shard_size=4)
    assert len(resolve_spec(tmp_path, "test")) == 3


def test_a_range_takes_the_shards_it_names(tmp_path: Path) -> None:
    write_split(tmp_path / "test", records=12, shard_size=4)
    assert len(resolve_spec(tmp_path, "test:0:2")) == 2
    assert len(resolve_spec(tmp_path, "test:2:")) == 1
    assert resolve_spec(tmp_path, "test:0:2")[0] != resolve_spec(tmp_path, "test:2:")[0]


def test_the_two_halves_of_a_split_do_not_share_a_shard(tmp_path: Path) -> None:
    """A record on both sides of the cut would make the reported number a fit."""
    write_split(tmp_path / "test", records=12, shard_size=4)
    first = set(resolve_spec(tmp_path, "test:0:2"))
    second = set(resolve_spec(tmp_path, "test:2:"))
    assert not first & second
    assert first | second == set(resolve_spec(tmp_path, "test"))


def test_a_range_that_selects_nothing_is_an_error(tmp_path: Path) -> None:
    write_split(tmp_path / "test", records=4, shard_size=4)
    with pytest.raises(ValueError):
        resolve_spec(tmp_path, "test:5:9")


def test_a_malformed_spec_is_an_error(tmp_path: Path) -> None:
    write_split(tmp_path / "test", records=4, shard_size=4)
    with pytest.raises(ValueError):
        resolve_spec(tmp_path, "test:1")


def test_counting_is_exact_when_a_short_shard_lands_mid_list(tmp_path: Path) -> None:
    """Only the last shard of a run is short, and merging buries it in the middle.

    Ten records at four a shard is 4 + 4 + 2, so a merged pair of runs has a short
    shard that a whole-list estimate would count as full.
    """
    write_split(tmp_path / "train", records=10, shard_size=4)
    write_split(tmp_path / "extra", records=10, shard_size=4)
    shards, total = resolve_splits(tmp_path, ["train", "extra"])
    assert len(shards) == 6
    assert total == 20


def test_requantising_changes_the_pixels_but_not_the_shape() -> None:
    image = textured()
    out = requantise(image, quality=30)
    assert out.shape == image.shape and out.dtype == image.dtype
    assert not np.array_equal(out, image)


def test_a_lower_quality_moves_the_image_further() -> None:
    """The point of the range: the two ends have to be visibly different."""
    image = textured()
    coarse = np.abs(requantise(image, 30).astype(int) - image.astype(int)).mean()
    fine = np.abs(requantise(image, 95).astype(int) - image.astype(int)).mean()
    assert coarse > fine


def test_both_views_take_the_same_quality_and_keep_the_label() -> None:
    sample = SpoofSample(tight=textured(1), wide=textured(2), label=1)
    out = recompress(sample, quality=40)
    assert out.label == 1
    assert out.tight.shape == sample.tight.shape and out.wide.shape == sample.wide.shape
    assert not np.array_equal(out.tight, sample.tight)
    assert not np.array_equal(out.wide, sample.wide)


def test_the_quality_range_spans_both_pools() -> None:
    low, high = QUALITY_RANGE
    assert low < 50 < high


def test_validation_is_never_recompressed(tmp_path: Path) -> None:
    """Augmenting the split a checkpoint is chosen on would move the target."""
    write_split(tmp_path / "test", records=8, shard_size=4)
    dataset = SpoofShardDataset(tmp_path, size=SIZE, train=False, splits="test")
    assert dataset.shuffle_buffer == 0

    plain = list(dataset)
    again = list(dataset)
    assert len(plain) == 8
    for first, second in zip(plain, again, strict=True):
        assert np.array_equal(first.tight, second.tight)


def test_a_training_pass_can_reach_both_augmentations(tmp_path: Path) -> None:
    write_split(tmp_path / "train", records=64, shard_size=8)
    dataset = SpoofShardDataset(
        tmp_path, size=SIZE, train=True, splits="train", recompress_probability=1.0
    )
    assert len(list(dataset)) == 64
