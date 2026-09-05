"""E6-T4 and E6-T5: the two-scale student, its loss, and the shard reader."""

from __future__ import annotations

import io
import json
from pathlib import Path

import numpy as np
import pytest
import torch
import yaml
from PIL import Image
from torch.utils.data import DataLoader

from facepipe.core.trainer import CKPT_BEST, CKPT_LAST
from facepipe.data.prepare.images_to_wds import ShardWriter
from facepipe.tasks.antispoof import train_kd as antispoof_train_kd
from facepipe.tasks.antispoof.data import (
    SpoofSample,
    SpoofShardDataset,
    collate,
    count_records,
    crop_scale,
    horizontal_flip,
)
from facepipe.tasks.antispoof.losses import SpoofTaskLoss
from facepipe.tasks.antispoof.losses.task_loss import LIVE, SPOOF
from facepipe.tasks.antispoof.student import INPUT_SIZE, HardSigmoid, MiniFASNetV2SE
from facepipe.tasks.antispoof.teacher import train_teacher
from facepipe.tasks.antispoof.teacher.cdcnpp import CDCNpp
from facepipe.tasks.antispoof.losses.task_loss import SpoofBatch
from facepipe.tasks.antispoof.teacher.depth_gt import DEPTH_SIZE, live_reference_mean
from facepipe.tasks.antispoof.teacher.train_teacher import DepthSupervision, liveness


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
    seen = sum(labels.numel() for _, _, labels, _ in loader)
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


def test_collate_keeps_the_pair_and_the_label_aligned(tmp_path: Path) -> None:
    root = write_shards(tmp_path / "train", records=4, shard_size=4)
    batch = list(SpoofShardDataset(root, size=32, train=False))
    tight, wide, labels, scales = collate(batch)
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
    batch = SpoofBatch(torch.tensor([0, 1]), torch.tensor([2.7, 2.7]))

    wrong_on_live = loss(torch.stack([confident_spoof, confident_spoof]), batch)
    wrong_on_spoof = loss(torch.stack([confident_live, confident_live]), batch)
    assert wrong_on_live > wrong_on_spoof


def test_an_unweighted_loss_treats_the_two_errors_alike() -> None:
    loss = SpoofTaskLoss(live_weight=1.0)
    confident_live = torch.tensor([4.0, -4.0])
    confident_spoof = torch.tensor([-4.0, 4.0])
    batch = SpoofBatch(torch.tensor([0, 1]), torch.tensor([2.7, 2.7]))

    wrong_on_live = loss(torch.stack([confident_spoof, confident_spoof]), batch)
    wrong_on_spoof = loss(torch.stack([confident_live, confident_live]), batch)
    assert torch.allclose(wrong_on_live, wrong_on_spoof)


def test_the_loss_buffer_follows_the_logits_device() -> None:
    loss = SpoofTaskLoss()
    logits = torch.tensor([[1.0, 0.0]], dtype=torch.float64)
    batch = SpoofBatch(torch.tensor([0]), torch.tensor([2.7]))
    assert loss(logits, batch).dtype == torch.float64


def teacher_map(labels: list[int], wide_scale: float = 2.7) -> torch.Tensor:
    import numpy as np

    from facepipe.tasks.antispoof.teacher.depth_gt import depth_batch

    return torch.from_numpy(depth_batch(np.array(labels), wide_scale))


def spoof_batch(labels: list[int], wide_scale: float = 2.7) -> SpoofBatch:
    return SpoofBatch(
        torch.tensor(labels), torch.full((len(labels),), wide_scale, dtype=torch.float32)
    )


def test_a_flat_input_leaves_no_central_difference_inside_the_border() -> None:
    """theta mixes in the centre-subtracted response, which a constant image
    cancels exactly. The border does not cancel: zero padding makes the ordinary
    term sum fewer real pixels than the difference term subtracts."""
    from facepipe.tasks.antispoof.teacher.cdcnpp import CDConv2d

    conv = CDConv2d(3, 4, theta=1.0)
    flat = torch.full((1, 3, 8, 8), 0.7)
    assert conv(flat)[:, :, 1:-1, 1:-1].abs().max() < 1e-5


def test_theta_zero_is_an_ordinary_convolution() -> None:
    from facepipe.tasks.antispoof.teacher.cdcnpp import CDConv2d

    conv = CDConv2d(3, 4, theta=0.0)
    x = torch.randn(1, 3, 8, 8)
    assert torch.allclose(conv(x), conv.conv(x))


def test_the_teacher_returns_a_depth_map_not_a_logit() -> None:
    from facepipe.tasks.antispoof.teacher.cdcnpp import CDCNpp
    from facepipe.tasks.antispoof.teacher.depth_gt import DEPTH_SIZE

    model = CDCNpp(width=8).eval()
    views = (torch.randn(2, 3, INPUT_SIZE, INPUT_SIZE),) * 2
    with torch.no_grad():
        depth = model(views)
    assert depth.shape == (2, DEPTH_SIZE, DEPTH_SIZE)
    assert depth.min() >= 0.0


def test_an_attack_target_is_flat_and_a_live_one_is_not() -> None:
    from facepipe.tasks.antispoof.teacher.depth_gt import depth_target

    assert depth_target(1, 2.7).max() == 0.0
    assert depth_target(0, 2.7).max() > 0.9


def test_the_live_target_stops_at_the_face_box() -> None:
    """Supervising the room as live surface asks the background to carry the label."""
    from facepipe.tasks.antispoof.teacher.depth_gt import depth_target, face_mask

    mound, face = depth_target(0, 2.7), face_mask(2.7)
    assert face.mean() < 0.2
    assert mound[~face].max() == 0.0
    assert mound[face].sum() == pytest.approx(mound.sum())


def test_a_flat_map_still_costs_a_live_face_the_whole_mound() -> None:
    """Masking the target without renormalising would make flat maps nearly free."""
    from facepipe.tasks.antispoof.teacher.depth_gt import depth_target

    supervision = DepthSupervision()
    flat = torch.zeros(1, DEPTH_SIZE, DEPTH_SIZE)
    whole_map_mean = float(depth_target(0, 2.7).mean())

    cost = float(supervision(flat, torch.tensor([LIVE]), torch.tensor([2.7])))
    assert cost > 5.0 * whole_map_mean


def test_score_distillation_costs_more_when_the_student_disagrees() -> None:
    """The bug this guards: a live map averages about 0.06 over the whole map,
    so reading that mean as a probability puts a live face far under one half and
    inverts the term."""
    from facepipe.tasks.antispoof.losses import ScoreDistillLoss

    loss = ScoreDistillLoss()
    says_live = torch.tensor([[5.0, -5.0]])
    says_spoof = torch.tensor([[-5.0, 5.0]])

    live, attack = spoof_batch([0]), spoof_batch([1])
    assert loss(says_spoof, teacher_map([0]), live) > loss(says_live, teacher_map([0]), live)
    assert loss(says_live, teacher_map([1]), attack) > loss(says_spoof, teacher_map([1]), attack)


def test_every_contrast_kernel_sums_to_zero() -> None:
    """A kernel that did not sum to zero would read brightness, not contrast."""
    from facepipe.tasks.antispoof.losses import contrast_kernels

    kernels = contrast_kernels()
    assert kernels.shape == (8, 1, 3, 3)
    assert torch.allclose(kernels.sum(dim=(1, 2, 3)), torch.zeros(8))


def test_depth_distillation_needs_a_feature_layer() -> None:
    from facepipe.tasks.antispoof.losses import DepthMapDistillLoss

    loss = DepthMapDistillLoss(embedding=16)
    with pytest.raises(ValueError, match="feature layer"):
        loss(torch.zeros(1, 2), teacher_map([0]), spoof_batch([0]))


def test_the_loader_size_comes_from_the_model_input(tmp_path: Path) -> None:
    """Declaring the input twice lets one copy drift: the model would be built
    for one size while the loader kept feeding the other."""
    import yaml

    from facepipe.core.config import load_config
    from facepipe.tasks.antispoof.train_kd import crop_size

    payload = {
        "run": {"task": "antispoof", "artifacts_root": str(tmp_path)},
        "model": {"name": "minifasnet_v2_se", "input_hw": [96, 96]},
        "data": {"name": "celeba_spoof", "params": {"shards": str(tmp_path)}},
    }
    path = tmp_path / "cfg.yaml"
    path.write_text(yaml.safe_dump(payload), encoding="utf-8")
    assert crop_size(load_config(path)) == 96


def test_a_rectangular_input_is_refused(tmp_path: Path) -> None:
    import yaml

    from facepipe.core.config import load_config
    from facepipe.tasks.antispoof.train_kd import crop_size

    payload = {
        "run": {"task": "antispoof", "artifacts_root": str(tmp_path)},
        "model": {"name": "minifasnet_v2_se", "input_hw": [80, 96]},
        "data": {"name": "celeba_spoof", "params": {"shards": str(tmp_path)}},
    }
    path = tmp_path / "cfg.yaml"
    path.write_text(yaml.safe_dump(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="square"):
        crop_size(load_config(path))


def test_the_loss_builds_the_same_target_the_dataset_side_does() -> None:
    """Two implementations of one formula, one on GPU per step and one in numpy."""
    from facepipe.tasks.antispoof.teacher.depth_gt import depth_batch

    labels, scales = torch.tensor([LIVE, SPOOF, LIVE]), torch.tensor([2.7, 1.8, 1.0])
    torch_side = DepthSupervision().targets(labels, scales)
    numpy_side = torch.from_numpy(depth_batch(labels.numpy(), scales.numpy()))
    assert torch.allclose(torch_side, numpy_side, atol=1e-6)


def test_depth_supervision_is_zero_on_a_perfect_map() -> None:
    supervision = DepthSupervision()
    labels, scales = torch.tensor([LIVE, SPOOF]), torch.tensor([2.7, 1.4])
    target = supervision.targets(labels, scales)
    assert float(supervision(target, labels, scales)) == pytest.approx(0.0, abs=1e-6)


def test_depth_supervision_punishes_a_flat_map_for_a_live_face() -> None:
    supervision = DepthSupervision()
    labels, scales = torch.tensor([LIVE]), torch.tensor([2.7])
    flat = torch.zeros(1, DEPTH_SIZE, DEPTH_SIZE)
    assert float(supervision(flat, labels, scales)) > 0.1


def test_the_contrast_term_carries_weight_against_the_level_term() -> None:
    """A smooth mound's neighbour differences are small, so an equal weight is not.

    Left at one the contrast term is a few percent of the L1 and cannot stop the
    uniform blob that satisfies the L1; the default brings the two within reach
    of each other on a prediction that is close but structureless.
    """
    torch.manual_seed(0)
    labels, scales = torch.tensor([LIVE]), torch.tensor([2.7])
    level_only = DepthSupervision(contrast_weight=0.0)
    target = level_only.targets(labels, scales)
    noisy = target + torch.randn_like(target) * 0.05

    level = float(level_only(noisy, labels, scales))
    contrast = float(DepthSupervision()(noisy, labels, scales)) - level
    assert 0.2 < contrast / level < 5.0


def test_the_contrast_term_ignores_a_map_that_is_only_too_bright() -> None:
    """Shifting every pixel alike leaves every neighbour difference untouched."""
    labels, scales = torch.tensor([LIVE]), torch.tensor([2.7])
    supervision = DepthSupervision()
    shifted = supervision.targets(labels, scales) + 0.05
    level_only = float(DepthSupervision(contrast_weight=0.0)(shifted, labels, scales))
    assert float(supervision(shifted, labels, scales)) == pytest.approx(level_only, abs=1e-2)


def test_the_teacher_score_reads_a_perfect_live_map_as_one() -> None:
    """Dividing by the mound's own mean is what puts a live face at 1, not at 0.42."""
    supervision = DepthSupervision()
    labels, scales = torch.tensor([LIVE, SPOOF]), torch.tensor([2.7, 1.4])
    reference = torch.from_numpy(live_reference_mean(scales.numpy()))
    scores = liveness(supervision.targets(labels, scales), reference)
    assert float(scores[0]) == pytest.approx(1.0)
    assert float(scores[1]) == pytest.approx(0.0)


def write_split_shards(root: Path, records: int = 8) -> Path:
    for split in ("train", "valid"):
        write_shards(root / split, records=records, shard_size=4)
    return root


def teacher_config(tmp_path: Path, shards: Path) -> Path:
    payload = {
        "run": {"task": "antispoof", "seed": 42, "artifacts_root": str(tmp_path / "artifacts")},
        "model": {
            "name": "cdcnpp",
            "input_hw": [INPUT_SIZE, INPUT_SIZE],
            "params": {"theta": 0.7, "depth_size": 8, "width": 8},
        },
        "data": {
            "name": "celeba_spoof",
            "batch_size": 2,
            "num_workers": 0,
            "params": {"shards": str(shards), "supervision": {"depth_size": 8}},
        },
        "train": {"epochs": 1, "amp": False, "device": "cpu", "log_every_steps": 1},
        "optim": {"name": "adam", "lr": 0.0001},
        "sched": {"name": "cosine"},
        "log": {"tensorboard": False},
    }
    path = tmp_path / "teacher.yaml"
    path.write_text(yaml.safe_dump(payload), encoding="utf-8")
    return path


def test_the_teacher_trains_and_reports_acer(tmp_path: Path) -> None:
    shards = write_split_shards(tmp_path / "shards")
    assert train_teacher.main(["--cfg", str(teacher_config(tmp_path, shards))]) == 0

    run = next((tmp_path / "artifacts" / "antispoof" / "runs").iterdir())
    assert (run / "ckpt" / CKPT_LAST).is_file()
    # ACER is what picks the best epoch, so a missing best.pth means val_fn never
    # produced the metric the teacher is accepted on.
    assert (run / "ckpt" / CKPT_BEST).is_file()


def student_config(tmp_path: Path, shards: Path, teacher_ckpt: Path | None) -> Path:
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
    if teacher_ckpt is not None:
        payload["teacher"] = {
            "enabled": True,
            "name": "cdcnpp",
            "ckpt": str(teacher_ckpt),
            "params": {"theta": 0.7, "depth_size": 8, "width": 8},
        }
        payload["distill"] = {
            "enabled": True,
            "feature_layers": ["drop"],
            "losses": [
                {"name": "antispoof_kd_logit", "weight": 1.0},
                {
                    "name": "antispoof_kd_depth_map",
                    "weight": 1.0,
                    "params": {"embedding": 32, "depth_size": 8},
                },
                {
                    "name": "antispoof_contrastive_depth",
                    "weight": 0.5,
                    "params": {"embedding": 32, "depth_size": 8},
                },
            ],
        }
    path = tmp_path / "student.yaml"
    path.write_text(yaml.safe_dump(payload), encoding="utf-8")
    return path


def test_the_baseline_student_trains_without_a_teacher(tmp_path: Path) -> None:
    shards = write_split_shards(tmp_path / "shards")
    assert antispoof_train_kd.main(["--cfg", str(student_config(tmp_path, shards, None))]) == 0
    run = next((tmp_path / "artifacts" / "antispoof" / "runs").iterdir())
    assert (run / "ckpt" / CKPT_LAST).is_file()


def test_the_kd_arm_runs_every_term_the_branch_has(tmp_path: Path) -> None:
    """The depth terms project from a student feature, so this covers the hooks too."""
    shards = write_split_shards(tmp_path / "shards")
    teacher_ckpt = tmp_path / "teacher.pth"
    teacher = CDCNpp(theta=0.7, depth_size=8, width=8)
    torch.save({"model": teacher.state_dict()}, teacher_ckpt)

    cfg_path = student_config(tmp_path, shards, teacher_ckpt)
    assert antispoof_train_kd.main(["--cfg", str(cfg_path)]) == 0
    run = next((tmp_path / "artifacts" / "antispoof" / "runs").iterdir())
    assert (run / "ckpt" / CKPT_LAST).is_file()


def test_the_depth_projections_are_trained_by_the_run(tmp_path: Path) -> None:
    """They live in the losses, so an optimizer over the student alone misses them."""
    from facepipe.core.config import load_config
    from facepipe.core.distiller import DistillLossSet
    from facepipe.core.registry import MODELS
    from facepipe.core.scheduler import build_optimizer

    shards = write_split_shards(tmp_path / "shards")
    teacher_ckpt = tmp_path / "teacher.pth"
    torch.save({"model": CDCNpp(theta=0.7, depth_size=8, width=8).state_dict()}, teacher_ckpt)
    cfg = load_config(student_config(tmp_path, shards, teacher_ckpt))

    student = MODELS.build({"name": cfg.model.name, "params": cfg.model.params})
    loss_set = DistillLossSet.from_config(cfg.distill)
    distiller = antispoof_train_kd.Distiller(
        student=student,
        teacher=antispoof_train_kd.build_teacher(cfg),
        loss_set=loss_set,
        task_loss=None,
    )
    tracked = {
        id(p)
        for group in build_optimizer(distiller, cfg.optim).param_groups
        for p in group["params"]
    }
    projection = loss_set.terms[1].fn.project[0].weight
    assert id(projection) in tracked


def test_the_teacher_is_loaded_from_its_ema_copy() -> None:
    """A run with EMA on validates its EMA copy, so that is the measured model."""
    live = {"weight": torch.zeros(2)}
    shadow = {"weight": torch.ones(2)}
    payload = {"model": live, "ema": {"decay": 0.999, "module": shadow}}
    assert antispoof_train_kd.trained_weights(payload) is shadow
    assert antispoof_train_kd.trained_weights({"model": live}) is live
