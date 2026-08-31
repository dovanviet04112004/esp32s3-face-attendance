"""E6-T4 and E6-T5: the two-scale student, its loss, and the shard reader."""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest
import torch
from PIL import Image
from torch.utils.data import DataLoader

from facepipe.data.prepare.images_to_wds import ShardWriter
from facepipe.tasks.antispoof.data import (
    SpoofSample,
    SpoofShardDataset,
    collate,
    count_records,
    horizontal_flip,
)
from facepipe.tasks.antispoof.losses import SpoofTaskLoss
from facepipe.tasks.antispoof.student import INPUT_SIZE, HardSigmoid, MiniFASNetV2SE


def crop_bytes(shade: int, size: int = 128) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (size, size), (shade, shade, shade)).save(buffer, format="JPEG")
    return buffer.getvalue()


def write_shards(root: Path, records: int, shard_size: int = 4) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    with ShardWriter(root, shard_size=shard_size) as writer:
        for index in range(records):
            meta = {"name": f"f{index}", "label": index % 2, "split": "train"}
            writer.add(
                {
                    "tight.jpg": crop_bytes(10 + index),
                    "wide.jpg": crop_bytes(200 - index),
                    "json": json.dumps(meta).encode(),
                }
            )
    return root


def test_the_student_is_two_backbones_and_one_head() -> None:
    model = MiniFASNetV2SE()
    total = sum(p.numel() for p in model.parameters())
    per_branch = sum(p.numel() for p in model.tight.parameters())
    assert 0.50e6 < total < 0.56e6, total
    assert per_branch == sum(p.numel() for p in model.wide.parameters())
    assert model.tight is not model.wide


def test_the_two_views_are_not_the_same_weights() -> None:
    model = MiniFASNetV2SE().eval()
    tight = torch.randn(2, 3, INPUT_SIZE, INPUT_SIZE)
    wide = torch.randn(2, 3, INPUT_SIZE, INPUT_SIZE)
    with torch.no_grad():
        swapped_differs = not torch.allclose(model((tight, wide)), model((wide, tight)))
    assert swapped_differs


def test_forward_returns_one_logit_per_class() -> None:
    model = MiniFASNetV2SE(num_classes=2).eval()
    views = (torch.randn(3, 3, INPUT_SIZE, INPUT_SIZE),) * 2
    with torch.no_grad():
        assert model(views).shape == (3, 2)


def test_hard_sigmoid_is_the_clamped_line_int8_can_reproduce() -> None:
    gate = HardSigmoid()
    x = torch.tensor([-4.0, -3.0, 0.0, 3.0, 4.0])
    assert torch.allclose(gate(x), torch.tensor([0.0, 0.0, 0.5, 1.0, 1.0]))


def test_count_records_matches_a_full_read(tmp_path: Path) -> None:
    root = write_shards(tmp_path / "train", records=10, shard_size=4)
    ds = SpoofShardDataset(root, size=32, train=False)
    assert count_records(ds.shards, shard_size=4) == 10
    assert len(list(ds)) == 10


def test_every_record_is_read_once_across_workers(tmp_path: Path) -> None:
    """The bug this guards: without a per-worker shard split each reader walks
    every shard, so an epoch trains on each record num_workers times."""
    root = write_shards(tmp_path / "train", records=12, shard_size=2)
    ds = SpoofShardDataset(root, size=32, train=False)
    loader = DataLoader(ds, batch_size=1, num_workers=3, collate_fn=collate)
    seen = sum(labels.numel() for _, _, labels in loader)
    assert seen == 12


def test_a_missing_shard_directory_is_reported(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        SpoofShardDataset(tmp_path / "absent", size=32)


def test_flip_mirrors_both_views_together() -> None:
    import numpy as np

    tight = np.arange(2 * 2 * 3, dtype=np.uint8).reshape(2, 2, 3)
    wide = (tight + 1).astype(np.uint8)
    flipped = horizontal_flip(SpoofSample(tight, wide, label=1))
    assert (flipped.tight == tight[:, ::-1]).all()
    assert (flipped.wide == wide[:, ::-1]).all()
    assert flipped.label == 1


def test_collate_keeps_the_pair_and_the_label_aligned(tmp_path: Path) -> None:
    root = write_shards(tmp_path / "train", records=4, shard_size=4)
    batch = list(SpoofShardDataset(root, size=32, train=False))
    tight, wide, labels = collate(batch)
    assert tight.shape == wide.shape == (4, 3, 32, 32)
    assert labels.tolist() == [0, 1, 0, 1]
    assert not torch.allclose(tight, wide)


def test_the_loss_weights_the_class_the_data_is_short_of() -> None:
    """Weighted cross entropy divides by the weights present, so a batch of one
    class alone scores the same either way. The effect only shows in a mixed
    batch, which is also the only kind training sees."""
    loss = SpoofTaskLoss(live_weight=1.97)
    confident_live = torch.tensor([4.0, -4.0])
    confident_spoof = torch.tensor([-4.0, 4.0])
    labels = torch.tensor([0, 1])

    wrong_on_live = loss(torch.stack([confident_spoof, confident_spoof]), labels)
    wrong_on_spoof = loss(torch.stack([confident_live, confident_live]), labels)
    assert wrong_on_live > wrong_on_spoof


def test_an_unweighted_loss_treats_the_two_errors_alike() -> None:
    loss = SpoofTaskLoss(live_weight=1.0)
    confident_live = torch.tensor([4.0, -4.0])
    confident_spoof = torch.tensor([-4.0, 4.0])
    labels = torch.tensor([0, 1])

    wrong_on_live = loss(torch.stack([confident_spoof, confident_spoof]), labels)
    wrong_on_spoof = loss(torch.stack([confident_live, confident_live]), labels)
    assert torch.allclose(wrong_on_live, wrong_on_spoof)


def test_the_loss_buffer_follows_the_logits_device() -> None:
    loss = SpoofTaskLoss()
    logits = torch.tensor([[1.0, 0.0]], dtype=torch.float64)
    assert loss(logits, torch.tensor([0])).dtype == torch.float64
