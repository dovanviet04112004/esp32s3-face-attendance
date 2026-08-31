"""E4-T5: the single entry point runs the baseline arm, and stages gate the terms."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import pytest
import torch
import yaml
from PIL import Image

from facepipe.core.config import StageSpec, load_config
from facepipe.core.distiller import StageSchedule
from facepipe.core.trainer import CKPT_LAST
from facepipe.tasks.detection import train_kd

INPUT_HW = (120, 160)


def test_a_stage_covers_its_own_span_of_epochs() -> None:
    schedule = StageSchedule(
        [
            StageSpec(epochs=2, losses=["feature"], task_loss_weight=0.0),
            StageSpec(epochs=3, losses=["feature", "logit"], task_loss_weight=0.5),
        ]
    )
    assert schedule.at(0).losses == ["feature"]
    assert schedule.at(1).losses == ["feature"]
    assert schedule.at(2).losses == ["feature", "logit"]
    assert schedule.at(4).task_loss_weight == 0.5


def test_past_the_last_stage_the_last_one_stays_in_force() -> None:
    schedule = StageSchedule([StageSpec(epochs=1, losses=["a"])])
    assert schedule.at(99).losses == ["a"]


def test_no_stages_means_nothing_is_gated() -> None:
    assert StageSchedule([]).at(0) is None


def test_a_stage_with_no_epochs_is_rejected() -> None:
    with pytest.raises(ValueError):
        StageSpec(epochs=0)


@dataclass
class Holder:
    left: torch.Tensor
    right: list[torch.Tensor]


def mover(channels_last: bool = False) -> object:
    from facepipe.core.trainer import Trainer

    fields = {
        "device": torch.device("cpu"),
        "channels_last": channels_last,
        "to_device": Trainer.to_device,
    }
    return type("S", (), fields)()


def test_targets_in_a_dataclass_are_moved_with_the_images() -> None:
    batch = Holder(left=torch.zeros(2), right=[torch.ones(3)])
    moved = mover().to_device(batch)
    assert moved is not batch
    assert isinstance(moved, Holder)
    assert torch.equal(moved.left, batch.left)
    assert torch.equal(moved.right[0], batch.right[0])


def test_channels_last_reaches_images_and_leaves_targets_alone() -> None:
    images = torch.zeros(2, 3, 8, 8)
    labels = torch.zeros(2, 4)
    moved = mover(channels_last=True).to_device([images, labels])
    assert moved[0].is_contiguous(memory_format=torch.channels_last)
    assert moved[1].is_contiguous()


def test_channels_last_off_leaves_the_layout_untouched() -> None:
    images = torch.zeros(2, 3, 8, 8)
    moved = mover().to_device(images)
    assert moved.is_contiguous()


def write_dataset(tmp_path: Path) -> tuple[Path, Path, Path]:
    images = tmp_path / "images" / "0--Parade"
    images.mkdir(parents=True)
    names = []
    for index in range(6):
        name = f"{index}.jpg"
        Image.new("RGB", (100, 200), (40, 80, 120)).save(images / name)
        names.append(f"0--Parade/{name}")

    coco = {
        "images": [
            {"id": i + 1, "file_name": n, "width": 100, "height": 200} for i, n in enumerate(names)
        ],
        "annotations": [
            {
                "image_id": i + 1,
                "bbox": [10.0, 20.0, 40.0, 60.0],
                "keypoints": [20, 30, 2, 60, 30, 2, 40, 50, 2, 25, 70, 2, 55, 70, 2],
                "num_keypoints": 5,
            }
            for i in range(len(names))
        ],
    }
    coco_path = tmp_path / "train.json"
    coco_path.write_text(json.dumps(coco), encoding="utf-8")
    split = tmp_path / "split.txt"
    split.write_text("\n".join(names) + "\n", encoding="utf-8")
    return coco_path, tmp_path / "images", split


def write_config(tmp_path: Path, coco: Path, images: Path, split: Path) -> Path:
    payload = {
        "run": {"task": "detection", "seed": 42, "artifacts_root": str(tmp_path / "artifacts")},
        "model": {"name": "yunet", "input_hw": list(INPUT_HW), "params": {}},
        "data": {
            "name": "widerface",
            "batch_size": 2,
            "num_workers": 0,
            "split_files": [str(split), str(split)],
            "params": {"coco": str(coco), "images": str(images)},
        },
        "train": {"epochs": 1, "amp": False, "device": "cpu", "log_every_steps": 1},
        "optim": {"name": "sgd", "lr": 0.001},
        "sched": {"name": "cosine"},
        "log": {"tensorboard": False},
    }
    path = tmp_path / "run.yaml"
    path.write_text(yaml.safe_dump(payload), encoding="utf-8")
    return path


def test_the_baseline_arm_trains_without_a_teacher(tmp_path: Path) -> None:
    cfg_path = write_config(tmp_path, *write_dataset(tmp_path))
    assert train_kd.main(["--cfg", str(cfg_path)]) == 0

    runs = sorted((tmp_path / "artifacts" / "detection" / "runs").iterdir())
    assert len(runs) == 1
    assert (runs[0] / "ckpt" / CKPT_LAST).is_file()
    assert (runs[0] / "config.resolved.yaml").is_file()
    assert (runs[0] / "split.lock").is_file()


def test_the_run_records_that_no_teacher_was_loaded(tmp_path: Path) -> None:
    cfg_path = write_config(tmp_path, *write_dataset(tmp_path))
    cfg = load_config(cfg_path)
    assert not cfg.teacher.enabled
    assert train_kd.build_teacher(cfg) is None


def test_validation_writes_a_best_checkpoint(tmp_path: Path) -> None:
    from facepipe.core.trainer import CKPT_BEST

    cfg_path = write_config(tmp_path, *write_dataset(tmp_path))
    assert train_kd.main(["--cfg", str(cfg_path)]) == 0
    run = next((tmp_path / "artifacts" / "detection" / "runs").iterdir())
    assert (run / "ckpt" / CKPT_BEST).is_file()


def test_a_single_split_says_so_instead_of_skipping_quietly(tmp_path: Path, caplog) -> None:
    coco, images, split = write_dataset(tmp_path)
    cfg_path = write_config(tmp_path, coco, images, split)
    payload = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    payload["data"]["split_files"] = [str(split)]
    cfg_path.write_text(yaml.safe_dump(payload), encoding="utf-8")

    with caplog.at_level("WARNING"):
        assert train_kd.main(["--cfg", str(cfg_path)]) == 0
    assert "no validation" in caplog.text

    run = next((tmp_path / "artifacts" / "detection" / "runs").iterdir())
    assert not (run / "ckpt" / "best.pth").exists()
