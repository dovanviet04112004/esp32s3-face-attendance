"""E4-T1: the teacher wrapper's guards and the WIDER-to-YOLO conversion."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from facepipe.tasks.detection.teacher import check_face_head
from facepipe.tasks.detection.teacher.finetune_widerface import (
    to_yolo_line,
    write_data_yaml,
    write_yolo_dataset,
)

LANDMARKS = [20.0, 30.0, 1, 60.0, 30.0, 1, 40.0, 50.0, 1, 25.0, 70.0, 1, 55.0, 70.0, 1]


def test_a_seventeen_keypoint_checkpoint_is_refused() -> None:
    with pytest.raises(ValueError, match="17 keypoints"):
        check_face_head((17, 3), num_classes=1)


def test_a_multi_class_checkpoint_is_refused() -> None:
    with pytest.raises(ValueError, match="classes"):
        check_face_head((5, 3), num_classes=80)


def test_a_face_head_passes() -> None:
    check_face_head((5, 3), num_classes=1)


def test_yolo_row_normalises_the_box_to_its_centre() -> None:
    row = to_yolo_line({"bbox": [10.0, 20.0, 40.0, 60.0], "keypoints": LANDMARKS}, 100, 200)
    fields = row.split()
    assert fields[0] == "0"
    assert float(fields[1]) == pytest.approx(0.30)
    assert float(fields[2]) == pytest.approx(0.25)
    assert float(fields[3]) == pytest.approx(0.40)
    assert float(fields[4]) == pytest.approx(0.30)


def test_yolo_row_carries_five_points_with_a_visibility_flag() -> None:
    row = to_yolo_line({"bbox": [0.0, 0.0, 10.0, 10.0], "keypoints": LANDMARKS}, 100, 100)
    assert len(row.split()) == 5 + 5 * 3


def test_a_face_without_landmarks_still_produces_a_full_row() -> None:
    row = to_yolo_line({"bbox": [0.0, 0.0, 10.0, 10.0], "num_keypoints": 0}, 100, 100)
    fields = row.split()
    assert len(fields) == 5 + 5 * 3
    assert [fields[7], fields[10]] == ["0", "0"]


def build_coco(tmp_path: Path) -> tuple[Path, Path, Path]:
    images_root = tmp_path / "images"
    for name in ("a/1.jpg", "a/2.jpg", "b/3.jpg"):
        target = images_root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"jpeg")

    coco = {
        "images": [
            {"id": 1, "file_name": "a/1.jpg", "width": 100, "height": 100},
            {"id": 2, "file_name": "a/2.jpg", "width": 100, "height": 100},
            {"id": 3, "file_name": "b/3.jpg", "width": 100, "height": 100},
        ],
        "annotations": [
            {"image_id": 1, "bbox": [10.0, 10.0, 20.0, 20.0], "keypoints": LANDMARKS},
            {"image_id": 1, "bbox": [50.0, 50.0, 10.0, 10.0], "keypoints": LANDMARKS},
            {"image_id": 2, "bbox": [0.0, 0.0, 30.0, 30.0], "keypoints": LANDMARKS},
        ],
    }
    coco_path = tmp_path / "train.json"
    coco_path.write_text(json.dumps(coco), encoding="utf-8")

    split = tmp_path / "split"
    split.mkdir()
    (split / "train.txt").write_text("a/1.jpg\n", encoding="utf-8")
    (split / "landmark_val.txt").write_text("a/2.jpg\n", encoding="utf-8")
    return coco_path, images_root, split


def test_conversion_follows_the_committed_split(tmp_path: Path) -> None:
    coco, images, split = build_coco(tmp_path)
    counts = write_yolo_dataset(coco, images, split, tmp_path / "yolo")
    assert counts == {"train": 1, "val": 1, "skipped": 1}


def test_images_are_linked_rather_than_copied(tmp_path: Path) -> None:
    coco, images, split = build_coco(tmp_path)
    write_yolo_dataset(coco, images, split, tmp_path / "yolo")
    link = tmp_path / "yolo" / "images" / "train" / "a__1.jpg"
    source = images / "a/1.jpg"
    assert link.stat().st_ino == source.stat().st_ino
    assert source.stat().st_nlink == 2


def test_every_face_of_an_image_becomes_one_row(tmp_path: Path) -> None:
    coco, images, split = build_coco(tmp_path)
    write_yolo_dataset(coco, images, split, tmp_path / "yolo")
    label = tmp_path / "yolo" / "labels" / "train" / "a__1.txt"
    assert len(label.read_text(encoding="utf-8").strip().splitlines()) == 2


def test_an_image_in_neither_list_is_left_out(tmp_path: Path) -> None:
    coco, images, split = build_coco(tmp_path)
    write_yolo_dataset(coco, images, split, tmp_path / "yolo")
    assert not (tmp_path / "yolo" / "images" / "train" / "b__3.jpg").exists()
    assert not (tmp_path / "yolo" / "images" / "val" / "b__3.jpg").exists()


def test_data_yaml_declares_a_five_point_face_head(tmp_path: Path) -> None:
    payload = yaml.safe_load(write_data_yaml(tmp_path).read_text(encoding="utf-8"))
    assert payload["kpt_shape"] == [5, 3]
    assert payload["names"] == {0: "face"}


def test_flip_index_swaps_left_and_right_and_fixes_the_nose(tmp_path: Path) -> None:
    payload = yaml.safe_load(write_data_yaml(tmp_path).read_text(encoding="utf-8"))
    assert payload["flip_idx"] == [1, 0, 2, 4, 3]


def test_the_shipped_teacher_config_names_a_face_teacher() -> None:
    from facepipe.core.config import load_config

    root = Path(__file__).resolve().parents[1]
    cfg = load_config(root / "configs/detection/teacher_yolo26m_pose.yaml")
    assert cfg.teacher.enabled and cfg.teacher.name == "yolo26_pose"
    assert set(cfg.teacher.params) >= {"coco", "images", "split_dir", "yolo_dataset"}


def test_coordinates_are_clamped_into_the_unit_square() -> None:
    over = {"bbox": [90.0, 90.0, 30.0, 30.0], "keypoints": [110.0, -5.0, 1, *LANDMARKS[3:]]}
    values = [float(v) for v in to_yolo_line(over, 100, 100).split()[1:]]
    assert max(values[:4]) <= 1.0
    assert 0.0 <= values[4] <= 1.0 and 0.0 <= values[5] <= 1.0


def test_a_face_running_off_the_frame_keeps_its_image() -> None:
    off = {"bbox": [0.0, 0.0, 10.0, 10.0], "keypoints": [106.8, 103.3, 1, *LANDMARKS[3:]]}
    points = [float(v) for v in to_yolo_line(off, 100, 100).split()[5:]]
    assert max(points[0::3] + points[1::3]) <= 1.01


def test_resume_reopens_the_last_checkpoint_of_the_named_run(tmp_path, monkeypatch) -> None:
    import facepipe.tasks.detection.teacher.finetune_widerface as module

    seen: dict[str, object] = {}

    class FakeYolo:
        def __init__(self, weights: str) -> None:
            seen["weights"] = weights

        def train(self, **kwargs: object) -> None:
            seen["kwargs"] = kwargs

    monkeypatch.setitem(__import__("sys").modules, "ultralytics", type(module)("ultralytics"))
    __import__("sys").modules["ultralytics"].YOLO = FakeYolo

    run = tmp_path / "20260830-1028_abc1234_def567"
    cfg = Path(__file__).resolve().parents[1] / "configs/detection/teacher_yolo26m_pose.yaml"
    assert module.main(["--cfg", str(cfg), "--resume", str(run)]) == 0
    assert seen["weights"] == str(run / "ultralytics" / "weights" / "last.pt")
    assert seen["kwargs"]["resume"] is True
    assert set(seen["kwargs"]) == {"resume", "workers", "batch"}
