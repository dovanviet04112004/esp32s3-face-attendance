"""E6-T4 and E6-T5: the two-scale model, its loss, and the shard reader."""

from __future__ import annotations

import io
import json
import random
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
import torch
import yaml
from PIL import Image
from torch.utils.data import DataLoader

from facepipe.core.trainer import CKPT_LAST
from facepipe.data.prepare.images_to_wds import ShardWriter
from facepipe.tasks.antispoof import train as antispoof_train
from facepipe.tasks.antispoof.data import (
    DEPTH_GRID,
    SpoofSample,
    SpoofShardDataset,
    collate,
    count_records,
    crop_scale,
    horizontal_flip,
    occlude,
    roll,
    translate,
)
from facepipe.tasks.antispoof.losses import SpoofTaskLoss
from facepipe.tasks.antispoof.losses.task_loss import LIVE, SPOOF, SpoofBatch
from facepipe.tasks.antispoof.model import INPUT_SIZE, HardSigmoid, MiniFASNetV2SE


def crop_bytes(shade: int, size: int = 128) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (size, size), (shade, shade, shade)).save(buffer, format="JPEG")
    return buffer.getvalue()


def write_shards(root: Path, records: int, shard_size: int = 4) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    with ShardWriter(root, shard_size=shard_size) as writer:
        for index in range(records):
            meta = {
                "name": f"f{index}",
                "label": index % 2,
                "split": "train",
                "wide_scale": 2.7,
            }
            writer.add(
                {
                    "tight.jpg": crop_bytes(10 + index),
                    "wide.jpg": crop_bytes(200 - index),
                    "json": json.dumps(meta).encode(),
                }
            )
    return root


def test_the_model_is_two_backbones_and_one_head() -> None:
    model = MiniFASNetV2SE(views="both")
    total = sum(p.numel() for p in model.parameters())
    per_branch = sum(p.numel() for p in model.tight.parameters())
    assert 0.50e6 < total < 0.56e6, total
    assert per_branch == sum(p.numel() for p in model.wide.parameters())
    assert model.tight is not model.wide


def test_the_two_views_are_not_the_same_weights() -> None:
    # Seeded: an unlucky draw leaves a fresh net near saturation, where both
    # orders read back the same and the test fails on the draw, not the code.
    torch.manual_seed(0)
    model = MiniFASNetV2SE(views="both").eval()
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
    seen = sum(batch[2].numel() for batch in loader)
    assert seen == 12


def test_a_missing_shard_directory_is_reported(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        SpoofShardDataset(tmp_path / "absent", size=32)


def test_flip_mirrors_both_views_together() -> None:
    import numpy as np

    tight = np.arange(2 * 2 * 3, dtype=np.uint8).reshape(2, 2, 3)
    wide = (tight + 1).astype(np.uint8)
    flipped = horizontal_flip(SpoofSample(tight, wide, label=1, wide_scale=2.7))
    assert (flipped.tight == tight[:, ::-1]).all()
    assert (flipped.wide == wide[:, ::-1]).all()
    assert flipped.label == 1


def wide_with_face(edge: int, face: tuple[float, float, float, float]) -> np.ndarray:
    """A context view whose face region is the only red patch in it."""
    image = np.full((edge, edge, 3), 40, dtype=np.uint8)
    x1, y1, x2, y2 = (round(value * edge) for value in face)
    image[y1:y2, x1:x2] = (255, 0, 0)
    return image


def face_fraction(image: np.ndarray) -> float:
    return float((image[:, :, 0] > 200).mean())


def sample_at(reached: float, edge: int = 224, label: int = LIVE) -> SpoofSample:
    """One record whose painted face really is `1 / reached` of the context view."""
    span = 1.0 / reached
    face = (0.5 - span / 2, 0.5 - span / 2, 0.5 + span / 2, 0.5 + span / 2)
    return SpoofSample(
        tight=np.zeros((edge, edge, 3), dtype=np.uint8),
        wide=wide_with_face(edge, face),
        label=label,
        wide_scale=reached,
        face_in_wide=face,
    )


def test_narrowing_the_context_view_leaves_the_face_and_drops_the_context() -> None:
    sample = sample_at(2.7)
    assert face_fraction(sample.wide) == pytest.approx((1 / 2.7) ** 2, abs=0.02)
    narrowed = crop_scale(sample, 1.0, size=224)
    assert narrowed.wide_scale == pytest.approx(1.0)
    assert face_fraction(narrowed.wide) > 0.95


def test_a_scale_below_one_bites_into_both_views_together() -> None:
    """A square shorter than the face box shortens the tight view by the same factor."""
    sample = sample_at(2.7)
    sample.tight[:] = 40
    sample.tight[40:184, 40:184] = (255, 0, 0)
    cut = crop_scale(sample, 0.7, size=224)
    assert cut.wide_scale == pytest.approx(0.7)
    assert face_fraction(cut.tight) > face_fraction(sample.tight)
    assert face_fraction(cut.wide) > 0.95


def test_the_drawn_scale_never_invents_context_the_frame_lacks() -> None:
    edge = 224
    sample = SpoofSample(
        tight=np.zeros((edge, edge, 3), dtype=np.uint8),
        wide=wide_with_face(edge, (0.1, 0.1, 0.9, 0.9)),
        label=SPOOF,
        wide_scale=1.2,
        face_in_wide=(0.1, 0.1, 0.9, 0.9),
    )
    widened = crop_scale(sample, 2.7, size=edge)
    assert widened.wide_scale == pytest.approx(1.2)
    assert (widened.wide == sample.wide).all()


def test_the_presented_scale_is_drawn_the_same_way_for_both_classes(tmp_path: Path) -> None:
    """Scale correlates with the label in the source pool, so the draw must not."""
    root = write_shards(tmp_path / "train", records=400, shard_size=50)
    dataset = SpoofShardDataset(root, size=32, train=True, seed=7)
    seen: dict[int, list[float]] = {LIVE: [], SPOOF: []}
    for sample in dataset:
        seen[sample.label].append(sample.wide_scale)
    live, spoof = np.array(seen[LIVE]), np.array(seen[SPOOF])
    assert live.min() < 1.2 and spoof.min() < 1.2
    assert live.max() > 2.4 and spoof.max() > 2.4
    assert abs(live.mean() - spoof.mean()) < 0.15


def test_the_shift_moves_the_context_view_less_than_the_face_view() -> None:
    """One displacement in the frame covers less of a crop that holds more room."""
    edge = 80
    tight = np.zeros((edge, edge, 3), dtype=np.uint8)
    wide = np.zeros((edge, edge, 3), dtype=np.uint8)
    tight[:, edge // 2] = 255
    wide[:, edge // 2] = 255
    moved = translate(SpoofSample(tight=tight, wide=wide, label=LIVE, wide_scale=4.0), 0.25, 0.0)
    tight_at = int(np.argmax(moved.tight[edge // 2, :, 0]))
    wide_at = int(np.argmax(moved.wide[edge // 2, :, 0]))
    assert edge // 2 - tight_at == pytest.approx(edge * 0.25, abs=2)
    assert edge // 2 - wide_at == pytest.approx(edge * 0.25 / 4.0, abs=2)


def test_the_shift_invents_no_flat_border() -> None:
    """Mirroring the edge keeps a moved crop free of a mark only shifts carry."""
    edge = 64
    view = np.random.default_rng(0).integers(40, 200, (edge, edge, 3), dtype=np.uint8)
    moved = translate(
        SpoofSample(tight=view, wide=view.copy(), label=SPOOF, wide_scale=2.7), -0.1, 0.1
    )
    assert moved.tight[:, :4].std() > 5.0 and moved.tight[-4:, :].std() > 5.0


def test_the_patch_covers_the_same_part_of_the_face_in_both_views() -> None:
    """Both crops hold one scene, so a hand on the cheek is on it in each."""
    edge = 64
    sample = SpoofSample(
        tight=np.full((edge, edge, 3), 200, dtype=np.uint8),
        wide=np.full((edge, edge, 3), 200, dtype=np.uint8),
        label=LIVE,
        wide_scale=2.0,
        face_in_wide=(0.25, 0.25, 0.75, 0.75),
    )
    covered = occlude(sample, random.Random(2), side_range=(0.4, 0.4))
    tight_hit = (covered.tight[:, :, 0] != 200).mean()
    wide_hit = (covered.wide[:, :, 0] != 200).mean()
    assert tight_hit > 0 and wide_hit > 0
    # The face fills the tight crop and a quarter of the wide one at 2.0x.
    assert tight_hit == pytest.approx(wide_hit * 4, rel=0.15)


def test_the_patch_lands_inside_the_face_box_of_the_wide_view() -> None:
    """Placed in face coordinates, so the room around the face keeps its pixels."""
    edge = 80
    sample = SpoofSample(
        tight=np.full((edge, edge, 3), 200, dtype=np.uint8),
        wide=np.full((edge, edge, 3), 200, dtype=np.uint8),
        label=SPOOF,
        wide_scale=4.0,
        face_in_wide=(0.375, 0.375, 0.625, 0.625),
    )
    for seed in range(20):
        covered = occlude(sample, random.Random(seed))
        touched = np.argwhere(covered.wide[:, :, 0] != 200)
        assert touched[:, 0].min() >= 30 and touched[:, 0].max() <= 49
        assert touched[:, 1].min() >= 30 and touched[:, 1].max() <= 49


@pytest.mark.parametrize(("probability", "patched"), [(0.0, False), (1.0, True)])
def test_the_occlusion_gate_decides_whether_a_patch_appears(
    tmp_path: Path, probability: float, patched: bool
) -> None:
    """The shards paint each view one shade, so a patch is the only second shade."""
    root = write_shards(tmp_path / "train", records=8, shard_size=8)
    dataset = SpoofShardDataset(
        root,
        size=32,
        train=True,
        seed=4,
        recompress_probability=0.0,
        photometric_probability=0.0,
        crop_scale_probability=0.0,
        occlusion_probability=probability,
    )
    spreads = [float(sample.tight.astype(np.float32).std()) for sample in dataset]
    assert (max(spreads) > 5.0) is patched


@pytest.mark.parametrize("probability", [0.0, 1.0])
def test_both_views_reach_the_model_size_whether_the_crop_gate_fires(
    tmp_path: Path, probability: float
) -> None:
    """The wide view is decoded at its native size, and only the recrop resizes it."""
    root = write_shards(tmp_path / "train", records=8, shard_size=8)
    dataset = SpoofShardDataset(
        root, size=32, train=True, seed=1, crop_scale_probability=probability
    )
    for sample in dataset:
        assert sample.tight.shape == sample.wide.shape == (32, 32, 3)


def test_collate_keeps_the_pair_and_the_label_aligned(tmp_path: Path) -> None:
    root = write_shards(tmp_path / "train", records=4, shard_size=4)
    batch = list(SpoofShardDataset(root, size=32, train=False))
    tight, wide, labels, scales = collate(batch)[:4]
    assert tight.shape == wide.shape == (4, 3, 32, 32)
    assert labels.tolist() == [0, 1, 0, 1]
    assert scales.tolist() == pytest.approx([2.7] * 4)
    assert not torch.allclose(tight, wide)


def test_the_loss_weights_the_class_the_data_is_short_of() -> None:
    """Weighted cross entropy divides by the weights present, so a batch of one
    class alone scores the same either way. The effect only shows in a mixed
    batch, which is also the only kind training sees."""
    loss = SpoofTaskLoss(live_weight=1.97)
    confident_live = torch.tensor([4.0, -4.0])
    confident_spoof = torch.tensor([-4.0, 4.0])
    batch = SpoofBatch(torch.tensor([0, 1]), torch.tensor([2.7, 2.7]),
                       torch.tensor([0, 0]))

    wrong_on_live = loss(torch.stack([confident_spoof, confident_spoof]), batch)
    wrong_on_spoof = loss(torch.stack([confident_live, confident_live]), batch)
    assert wrong_on_live > wrong_on_spoof


def test_an_unweighted_loss_treats_the_two_errors_alike() -> None:
    loss = SpoofTaskLoss(live_weight=1.0)
    confident_live = torch.tensor([4.0, -4.0])
    confident_spoof = torch.tensor([-4.0, 4.0])
    batch = SpoofBatch(torch.tensor([0, 1]), torch.tensor([2.7, 2.7]),
                       torch.tensor([0, 0]))

    wrong_on_live = loss(torch.stack([confident_spoof, confident_spoof]), batch)
    wrong_on_spoof = loss(torch.stack([confident_live, confident_live]), batch)
    assert torch.allclose(wrong_on_live, wrong_on_spoof)


def test_the_loss_buffer_follows_the_logits_device() -> None:
    loss = SpoofTaskLoss()
    logits = torch.tensor([[1.0, 0.0]], dtype=torch.float64)
    batch = SpoofBatch(torch.tensor([0]), torch.tensor([2.7]), torch.tensor([0]))
    assert loss(logits, batch).dtype == torch.float64




def spoof_batch(labels: list[int], wide_scale: float = 2.7) -> SpoofBatch:
    return SpoofBatch(
        torch.tensor(labels), torch.full((len(labels),), wide_scale, dtype=torch.float32)
    )




















def test_the_loader_size_comes_from_the_model_input(tmp_path: Path) -> None:
    """Declaring the input twice lets one copy drift: the model would be built
    for one size while the loader kept feeding the other."""

    from facepipe.core.config import load_config
    from facepipe.tasks.antispoof.train import crop_size

    payload = {
        "run": {"task": "antispoof", "artifacts_root": str(tmp_path)},
        "model": {"name": "minifasnet_v2_se", "input_hw": [96, 96]},
        "data": {"name": "celeba_spoof", "params": {"shards": str(tmp_path)}},
    }
    path = tmp_path / "cfg.yaml"
    path.write_text(yaml.safe_dump(payload), encoding="utf-8")
    assert crop_size(load_config(path)) == 96


def test_a_rectangular_input_is_refused(tmp_path: Path) -> None:

    from facepipe.core.config import load_config
    from facepipe.tasks.antispoof.train import crop_size

    payload = {
        "run": {"task": "antispoof", "artifacts_root": str(tmp_path)},
        "model": {"name": "minifasnet_v2_se", "input_hw": [80, 96]},
        "data": {"name": "celeba_spoof", "params": {"shards": str(tmp_path)}},
    }
    path = tmp_path / "cfg.yaml"
    path.write_text(yaml.safe_dump(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="square"):
        crop_size(load_config(path))














def write_split_shards(root: Path, records: int = 8) -> Path:
    for split in ("train", "valid"):
        write_shards(root / split, records=records, shard_size=4)
    return root








def run_config(tmp_path: Path, shards: Path) -> Path:
    payload = {
        "run": {"task": "antispoof", "seed": 42, "artifacts_root": str(tmp_path / "artifacts")},
        "model": {
            "name": "minifasnet_v2_se",
            "input_hw": [INPUT_SIZE, INPUT_SIZE],
            "params": {"num_classes": 2, "embedding": 16},
        },
        "data": {
            "name": "celeba_spoof",
            "batch_size": 2,
            "num_workers": 0,
            "params": {"shards": str(shards)},
        },
        "train": {"epochs": 1, "amp": False, "device": "cpu", "log_every_steps": 1},
        "optim": {"name": "sgd", "lr": 0.001},
        "sched": {"name": "cosine"},
        "log": {"tensorboard": False},
    }
    path = tmp_path / "run.yaml"
    path.write_text(yaml.safe_dump(payload), encoding="utf-8")
    return path


def test_the_entry_point_trains_and_writes_a_run(tmp_path: Path) -> None:
    shards = write_split_shards(tmp_path / "shards")
    assert antispoof_train.main(["--cfg", str(run_config(tmp_path, shards))]) == 0
    run = next((tmp_path / "artifacts" / "antispoof" / "runs").iterdir())
    assert (run / "ckpt" / CKPT_LAST).is_file()








def matched_depth(view: np.ndarray, grid: int = DEPTH_GRID) -> np.ndarray:
    """The crop's own luma, shrunk: a map that starts perfectly aligned."""
    grey = view.astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32)
    small = np.array(Image.fromarray(grey).resize((grid, grid), Image.BILINEAR), np.float32)
    return (small - small.mean()) / max(float(small.std()), 1e-6)


def still_aligned(sample: SpoofSample) -> float:
    """Correlation between the map and the crop it is supposed to describe."""
    want = matched_depth(sample.tight).ravel()
    got = sample.depth.astype(np.float32).ravel()
    got = (got - got.mean()) / max(float(got.std()), 1e-6)
    want = (want - want.mean()) / max(float(want.std()), 1e-6)
    return float(np.dot(want, got) / len(want))


@pytest.fixture
def depth_sample() -> SpoofSample:
    rng = np.random.default_rng(7)
    coarse = rng.integers(0, 255, (16, 16, 3), dtype=np.uint8)
    tight = np.array(Image.fromarray(coarse).resize((128, 128)), dtype=np.uint8)
    wide = np.array(Image.fromarray(tight).resize((224, 224)), dtype=np.uint8)
    return SpoofSample(tight=tight, wide=wide, label=LIVE, wide_scale=1.0,
                       depth=matched_depth(tight), face_in_wide=(0.25, 0.25, 0.75, 0.75))


# A map that drifts from its crop trains the head on the wrong face and nothing
# downstream can see it, which is why every geometric step is checked (KEHOACH 3).
@pytest.mark.parametrize(
    "name,apply",
    [
        ("flip", horizontal_flip),
        ("roll_negative", lambda s: roll(s, -18.0)),
        ("roll_positive", lambda s: roll(s, 12.0)),
        ("translate", lambda s: translate(s, 0.10, -0.06)),
        ("crop_scale", lambda s: crop_scale(s, 0.75, 128)),
        ("chained", lambda s: roll(translate(horizontal_flip(s), 0.08, 0.05), -9.0)),
    ],
)
def test_depth_follows_the_crop_through(name: str, apply, depth_sample: SpoofSample) -> None:
    assert still_aligned(depth_sample) > 0.99
    assert still_aligned(apply(depth_sample)) > 0.75


def test_a_sample_without_depth_survives_every_step(depth_sample: SpoofSample) -> None:
    bare = replace(depth_sample, depth=None)
    for step in (horizontal_flip, lambda s: roll(s, 8.0), lambda s: translate(s, 0.05, 0.05),
                 lambda s: crop_scale(s, 0.8, 128)):
        bare = step(bare)
    assert bare.depth is None
