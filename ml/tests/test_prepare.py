"""E3-T2, E3-T3 and E3-T4: the raw-to-interim converters on synthetic inputs."""

from __future__ import annotations

import json
import struct
import tarfile
from pathlib import Path

import pytest
from PIL import Image

from facepipe.data.prepare.celeba_spoof_parquet import scaled_box, split_of
from facepipe.data.prepare.device_index import build_rows, parse_name, write_manifest
from facepipe.data.prepare.recordio_to_wds import (
    IR_HEADER,
    RECORD_MAGIC,
    read_records,
    write_shards,
)
from facepipe.data.prepare.widerface_to_coco import build_coco, parse_label_file

LANDMARK_ROW = "10 10 40 40 15 20 0.9 35 20 0.9 25 30 0.9 18 40 0.9 32 40 0.9 1.0"
NO_LANDMARK_ROW = "60 60 20 20 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 0.5"


def make_image(path: Path, size: tuple[int, int] = (100, 80)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, (128, 128, 128)).save(path)


@pytest.fixture
def wider_fixture(tmp_path: Path) -> tuple[Path, Path]:
    images = tmp_path / "images"
    make_image(images / "0--Parade" / "a.jpg")
    make_image(images / "0--Parade" / "b.jpg")
    labels = tmp_path / "label.txt"
    labels.write_text(
        "# 0--Parade/a.jpg\n"
        f"{LANDMARK_ROW}\n"
        f"{NO_LANDMARK_ROW}\n"
        "# 0--Parade/b.jpg\n"
        f"{LANDMARK_ROW}\n",
        encoding="utf-8",
    )
    return labels, images


def test_label_parser_splits_images_and_faces(wider_fixture) -> None:
    labels, _ = wider_fixture
    samples = list(parse_label_file(labels))
    assert [s.relative_path for s in samples] == ["0--Parade/a.jpg", "0--Parade/b.jpg"]
    assert len(samples[0].faces) == 2
    assert samples[0].faces[0].has_landmarks
    assert not samples[0].faces[1].has_landmarks


def test_coco_carries_five_keypoints(wider_fixture) -> None:
    labels, images = wider_fixture
    coco = build_coco(labels, images)
    assert coco["info"]["num_images"] == 2
    assert coco["info"]["num_faces"] == 3
    assert coco["info"]["num_faces_with_landmarks"] == 2
    assert coco["categories"][0]["keypoints"] == [
        "left_eye",
        "right_eye",
        "nose",
        "left_mouth",
        "right_mouth",
    ]
    annotated = coco["annotations"][0]
    assert len(annotated["keypoints"]) == 15
    assert annotated["num_keypoints"] == 5


def test_face_without_landmarks_is_marked_invisible(wider_fixture) -> None:
    labels, images = wider_fixture
    coco = build_coco(labels, images)
    blind = next(a for a in coco["annotations"] if a["num_keypoints"] == 0)
    assert blind["keypoints"][2::3] == [0.0] * 5


def test_image_size_comes_from_the_file(wider_fixture) -> None:
    labels, images = wider_fixture
    coco = build_coco(labels, images)
    assert (coco["images"][0]["width"], coco["images"][0]["height"]) == (100, 80)


def test_absent_image_is_skipped_and_counted(tmp_path: Path) -> None:
    labels = tmp_path / "label.txt"
    labels.write_text(f"# missing/x.jpg\n{LANDMARK_ROW}\n", encoding="utf-8")
    coco = build_coco(labels, tmp_path / "images")
    assert coco["info"]["num_images"] == 0
    assert coco["info"]["skipped_images_absent"] == 1


def test_small_faces_can_be_dropped(wider_fixture) -> None:
    labels, images = wider_fixture
    coco = build_coco(labels, images, min_side_pixels=30.0)
    assert coco["info"]["num_faces"] == 2
    assert coco["info"]["skipped_faces_small"] == 1


def test_scaled_box_is_square_and_centred() -> None:
    left, top, right, bottom = scaled_box((10, 20, 50, 40), 1.0, 200, 200)
    assert right - left == bottom - top
    assert (left + right) / 2 == pytest.approx(30.0, abs=1.0)
    assert (top + bottom) / 2 == pytest.approx(30.0, abs=1.0)


def test_wide_crop_is_larger_than_tight_crop() -> None:
    tight = scaled_box((50, 50, 90, 90), 1.0, 400, 400)
    wide = scaled_box((50, 50, 90, 90), 2.7, 400, 400)
    assert (wide[2] - wide[0]) > (tight[2] - tight[0])


def test_scaled_box_stays_inside_the_image() -> None:
    left, top, right, bottom = scaled_box((0, 0, 40, 40), 2.7, 50, 50)
    assert left >= 0 and top >= 0
    assert right <= 50 and bottom <= 50


def test_box_is_read_as_corners_not_width_height() -> None:
    box = scaled_box((100, 200, 220, 410), 1.0, 450, 600)
    assert box[2] - box[0] == pytest.approx(210, abs=2)
    assert box[3] <= 600


def test_split_comes_from_the_shard_name() -> None:
    assert split_of(Path("test-00000-of-00065-abc.parquet")) == "test"
    assert split_of(Path("train-00014-of-00029-def.parquet")) == "train"
    assert split_of(Path("valid-00000-of-00009-xyz.parquet")) == "valid"
    assert split_of(Path("random.parquet")) == "unknown"


def write_rec(path: Path, samples: list[tuple[int, bytes]]) -> Path:
    """Write a minimal MXNet RecordIO, the container Glint360K ships in."""
    with path.open("wb") as handle:
        for label, payload in samples:
            body = IR_HEADER.pack(0, float(label), 0, 0) + payload
            handle.write(struct.pack("II", RECORD_MAGIC, len(body)))
            handle.write(body)
            handle.write(b"\0" * ((-len(body)) % 4))
    return path


def test_recordio_round_trips(tmp_path: Path) -> None:
    samples = [(7, b"\xff\xd8jpegbytes"), (42, b"\xff\xd8another"), (7, b"\xff\xd8third!!")]
    rec = write_rec(tmp_path / "train.rec", samples)
    records = list(read_records(rec))
    assert [(r.label, r.image) for r in records] == samples


def test_index_records_without_an_image_are_skipped(tmp_path: Path) -> None:
    rec = write_rec(
        tmp_path / "train.rec",
        [(7, b"\xff\xd8real"), (5179422, b""), (9, b"\xff\xd8also"), (5179510, b"")],
    )
    records = list(read_records(rec))
    assert [r.label for r in records] == [7, 9]


def test_bad_magic_is_reported(tmp_path: Path) -> None:
    path = tmp_path / "broken.rec"
    path.write_bytes(struct.pack("II", 0xDEADBEEF, 8) + b"\0" * 8)
    with pytest.raises(ValueError, match="bad magic"):
        list(read_records(path))


def test_shards_are_tars_with_image_and_label(tmp_path: Path) -> None:
    rec = write_rec(tmp_path / "train.rec", [(i % 3, b"\xff\xd8x") for i in range(7)])
    stats = write_shards(read_records(rec), tmp_path / "shards", shard_size=3)
    assert stats == {"records": 7, "shards": 3, "identities": 3}

    with tarfile.open(tmp_path / "shards" / "000000.tar") as shard:
        names = shard.getnames()
        assert names[:2] == ["000000000.jpg", "000000000.cls"]
        assert shard.extractfile("000000000.cls").read() == b"0"


def test_device_index_reads_meta_and_flags_bad_names(tmp_path: Path) -> None:
    root = tmp_path / "ov5640"
    make_image(root / "images" / "s01_0001.jpg")
    make_image(root / "images" / "badname.jpg")
    (root / "meta").mkdir(parents=True, exist_ok=True)
    (root / "meta" / "s01_0001.json").write_text(
        json.dumps(
            {
                "person_id": "emp007",
                "lighting": "dim",
                "distance_cm": 60,
                "is_spoof": False,
                "capture_date": "2026-08-27",
            }
        ),
        encoding="utf-8",
    )

    rows, unparsed = build_rows(root)
    assert unparsed == ["badname.jpg"]
    indexed = {row.file: row for row in rows}
    row = indexed["images/s01_0001.jpg"]
    assert (row.person_id, row.session, row.distance_cm, row.is_spoof) == (
        "emp007",
        "s01",
        "60",
        "0",
    )


def test_device_manifest_has_the_columns_the_plan_names(tmp_path: Path) -> None:
    root = tmp_path / "ov5640"
    make_image(root / "images" / "s01_0001.jpg")
    rows, _ = build_rows(root)
    target = write_manifest(root, rows)
    header = target.read_text(encoding="utf-8").splitlines()[0]
    assert header == "file,person_id,session,lighting,distance_cm,is_spoof,spoof_type,capture_date"


def test_parse_name_rejects_a_name_without_a_sequence() -> None:
    assert parse_name("s01_0001") == ("s01", "0001")
    assert parse_name("nosequence") == ("", "")
