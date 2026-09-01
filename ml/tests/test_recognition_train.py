"""E5-T4 and E5-T6: the entry point runs both arms, and the benchmark protocol."""

from __future__ import annotations

import io
import pickle
from pathlib import Path

import numpy as np
import pytest
import torch
import yaml
from PIL import Image

from facepipe.core.trainer import CKPT_BEST, CKPT_LAST
from facepipe.data.prepare.images_to_wds import ShardWriter
from facepipe.tasks.recognition import train_kd
from facepipe.tasks.recognition.data import TEACHER_DTYPE
from facepipe.tasks.recognition.eval import (
    evaluate_all,
    kfold_accuracy,
    pair_scores,
    read_bin,
    tar_at_far,
)

INPUT_HW = (112, 112)
IDENTITIES = 4
RECORDS = 16


def face_bytes(shade: int) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", INPUT_HW, (shade, 255 - shade, 128)).save(buffer, format="JPEG")
    return buffer.getvalue()


def write_dataset(tmp_path: Path) -> tuple[Path, Path]:
    shards = tmp_path / "shards"
    shards.mkdir(parents=True)
    with ShardWriter(shards, shard_size=4) as writer:
        for index in range(RECORDS):
            writer.add(
                {
                    "jpg": face_bytes(20 + index * 5),
                    "cls": str(index % IDENTITIES).encode("ascii"),
                }
            )
    split = tmp_path / "train_ids.txt"
    split.write_text("\n".join(str(i) for i in range(IDENTITIES)) + "\n", encoding="utf-8")
    return shards, split


def write_benchmark(tmp_path: Path, pairs: int = 4, names: tuple[str, ...] = ("lfw",)) -> Path:
    """A .bin in InsightFace's layout: encoded images then one flag per pair."""
    root = tmp_path / "benchmarks"
    root.mkdir(parents=True, exist_ok=True)
    encoded = [face_bytes(30 + index * 9) for index in range(pairs * 2)]
    issame = [index % 2 == 0 for index in range(pairs)]
    for name in names:
        with (root / f"{name}.bin").open("wb") as handle:
            pickle.dump((encoded, issame), handle)
    return root


def write_config(tmp_path: Path, shards: Path, split: Path, benchmarks: Path) -> Path:
    payload = {
        "run": {"task": "recognition", "seed": 42, "artifacts_root": str(tmp_path / "artifacts")},
        "model": {
            "name": "mobilefacenet",
            "input_hw": list(INPUT_HW),
            "params": {"embedding": 512, "width": 8},
        },
        "data": {
            "name": "ms1mv3",
            "batch_size": 4,
            "num_workers": 0,
            "split_files": [str(split), str(split)],
            "params": {
                "shards": str(shards),
                "benchmarks": str(benchmarks),
                "arcface": {"scale": 8.0, "margin": 0.2},
            },
        },
        "train": {"epochs": 1, "amp": False, "device": "cpu", "log_every_steps": 1},
        "optim": {"name": "sgd", "lr": 0.001},
        "sched": {"name": "cosine"},
        "log": {"tensorboard": False},
    }
    path = tmp_path / "run.yaml"
    path.write_text(yaml.safe_dump(payload), encoding="utf-8")
    return path


def runs_of(tmp_path: Path) -> list[Path]:
    return sorted((tmp_path / "artifacts" / "recognition" / "runs").iterdir())


def test_the_baseline_arm_trains_without_a_teacher(tmp_path: Path) -> None:
    shards, split = write_dataset(tmp_path)
    cfg_path = write_config(
        tmp_path, shards, split, write_benchmark(tmp_path, names=("lfw", "cfp_fp"))
    )
    assert train_kd.main(["--cfg", str(cfg_path)]) == 0

    run = runs_of(tmp_path)[0]
    assert (run / "ckpt" / CKPT_LAST).is_file()
    assert (run / "ckpt" / CKPT_BEST).is_file()
    assert (run / "config.resolved.yaml").is_file()


def test_the_arcface_centres_are_updated_by_the_run(tmp_path: Path) -> None:
    """They live in the loss, not the student, so an optimizer built over the
    student alone would leave them at their random initialisation."""
    shards, split = write_dataset(tmp_path)
    cfg_path = write_config(
        tmp_path, shards, split, write_benchmark(tmp_path, names=("lfw", "cfp_fp"))
    )

    from facepipe.core.config import load_config
    from facepipe.core.scheduler import build_optimizer

    cfg = load_config(cfg_path)
    student = train_kd.MODELS.build({"name": cfg.model.name, "params": cfg.model.params})
    loss = train_kd.LOSSES.get(train_kd.TASK_LOSS)(num_classes=IDENTITIES, embedding=512)
    distiller = train_kd.Distiller(student=student, teacher=None, loss_set=None, task_loss=loss)
    tracked = {
        id(p)
        for group in build_optimizer(distiller, cfg.optim).param_groups
        for p in group["params"]
    }
    assert id(loss.weight) in tracked


def test_the_kd_arm_reads_the_cache_instead_of_the_images(tmp_path: Path) -> None:
    shards, split = write_dataset(tmp_path)
    cache = tmp_path / "teacher.f16"
    rng = np.random.default_rng(0)
    rng.standard_normal((RECORDS, 512)).astype(TEACHER_DTYPE).tofile(cache)

    cfg_path = write_config(
        tmp_path, shards, split, write_benchmark(tmp_path, names=("lfw", "cfp_fp"))
    )
    payload = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    payload["teacher"] = {"enabled": True, "name": "cached_embedding"}
    payload["data"]["params"]["teacher_cache"] = str(cache)
    payload["distill"] = {
        "enabled": True,
        "losses": [
            {"name": "recognition_kd_embedding", "weight": 1.0},
            {"name": "recognition_kd_relation_rkd", "weight": 1.0},
        ],
    }
    cfg_path.write_text(yaml.safe_dump(payload), encoding="utf-8")

    assert train_kd.main(["--cfg", str(cfg_path)]) == 0
    assert (runs_of(tmp_path)[0] / "ckpt" / CKPT_LAST).is_file()


def test_distilling_without_a_cache_says_so(tmp_path: Path) -> None:
    """Silently distilling from nothing would produce a run that looks like an arm."""
    from facepipe.tasks.recognition.data import RecogTargets

    distiller = train_kd.CachedTeacherDistiller(
        student=torch.nn.Identity(), teacher=None, loss_set=None
    )
    with pytest.raises(ValueError, match="teacher_cache"):
        distiller.teacher_inputs(None, RecogTargets(labels=torch.zeros(1, dtype=torch.long)))


def test_a_rectangular_input_is_refused(tmp_path: Path) -> None:
    from facepipe.core.config import load_config

    shards, split = write_dataset(tmp_path)
    cfg_path = write_config(
        tmp_path, shards, split, write_benchmark(tmp_path, names=("lfw", "cfp_fp"))
    )
    payload = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    payload["model"]["input_hw"] = [112, 96]
    cfg_path.write_text(yaml.safe_dump(payload), encoding="utf-8")

    with pytest.raises(ValueError, match="square"):
        train_kd.crop_size(load_config(cfg_path))


def test_a_benchmark_reads_back_as_pairs(tmp_path: Path) -> None:
    root = write_benchmark(tmp_path, pairs=3)
    encoded, issame = read_bin(root / "lfw.bin")
    assert len(encoded) == 6
    assert issame.tolist() == [True, False, True]


def test_the_benchmark_runner_scores_every_set_it_finds(tmp_path: Path) -> None:
    from facepipe.tasks.recognition.student import MobileFaceNet

    root = write_benchmark(tmp_path, pairs=10)
    model = MobileFaceNet(width=8).eval()
    scores = evaluate_all(model, root, torch.device("cpu"), batch_size=4)
    assert set(scores) == {"lfw"}
    assert 0.0 <= scores["lfw"]["accuracy"] <= 1.0


def test_pair_scores_take_consecutive_rows() -> None:
    rows = np.array([[1.0, 0.0], [1.0, 0.0], [1.0, 0.0], [0.0, 1.0]], dtype=np.float32)
    assert pair_scores(rows).tolist() == pytest.approx([1.0, 0.0])


def test_a_perfectly_separable_set_scores_one() -> None:
    scores = np.concatenate([np.full(50, 0.9), np.full(50, -0.9)])
    issame = np.concatenate([np.ones(50, dtype=bool), np.zeros(50, dtype=bool)])
    assert kfold_accuracy(scores, issame, folds=5)["accuracy"] == pytest.approx(1.0)


def test_the_threshold_is_chosen_on_the_other_folds() -> None:
    """A threshold fitted on the fold it is scored on reports the training score.

    Half the pairs here are unseparable, so an honestly held-out threshold cannot
    reach the accuracy a fitted one would claim.
    """
    rng = np.random.default_rng(0)
    issame = rng.random(400) < 0.5
    scores = np.where(issame, 0.4, 0.3) + rng.normal(0, 0.3, 400)
    honest = kfold_accuracy(scores, issame, folds=10)["accuracy"]
    fitted = max(float(((scores >= t) == issame).mean()) for t in np.linspace(-1, 1, 401))
    assert honest < fitted


def test_tar_at_far_holds_the_false_accept_rate_it_promises() -> None:
    rng = np.random.default_rng(1)
    issame = np.zeros(2000, dtype=bool)
    issame[:1000] = True
    scores = np.where(issame, 0.8, 0.1) + rng.normal(0, 0.05, 2000)
    assert tar_at_far(scores, issame, 1e-3) > 0.9


def test_tar_at_far_reports_zero_when_no_threshold_is_strict_enough() -> None:
    """Zero is the honest answer: the model cannot operate at that rate at all."""
    issame = np.array([True, True, False, False])
    scores = np.array([0.1, 0.2, 0.9, 0.95])
    assert tar_at_far(scores, issame, 1e-4) == 0.0
