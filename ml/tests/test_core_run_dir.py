"""E2-T6: every run leaves a directory that is enough to reproduce it."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
import yaml

from facepipe.core.config import load_config
from facepipe.core.run_dir import (
    CONFIG_NAME,
    ENV_NAME,
    SPLIT_LOCK_NAME,
    create_run_dir,
    make_run_id,
)


def _config(config_file: Path, tmp_path: Path, **overrides: str):
    items = [f"run.artifacts_root={tmp_path / 'artifacts'}"]
    items += [f"{key}={value}" for key, value in overrides.items()]
    return load_config(config_file, items)


def test_creates_the_three_files(config_file: Path, tmp_path: Path) -> None:
    cfg = _config(config_file, tmp_path)
    run = create_run_dir(cfg)
    for name in (CONFIG_NAME, SPLIT_LOCK_NAME, ENV_NAME):
        assert (run.path / name).is_file(), name
    assert run.ckpt_dir.is_dir()
    assert run.tb_dir.is_dir()


def test_branch_is_the_first_axis(config_file: Path, tmp_path: Path) -> None:
    cfg = _config(config_file, tmp_path)
    run = create_run_dir(cfg)
    relative = run.path.relative_to(tmp_path / "artifacts")
    assert relative.parts[0] == "dummy"
    assert relative.parts[1] == "runs"
    assert run.run_id.startswith("dummy/")


def test_run_id_carries_stamp_sha_and_confighash(config_file: Path, tmp_path: Path) -> None:
    cfg = _config(config_file, tmp_path)
    parts = make_run_id(cfg).split("_")
    assert len(parts) == 3
    stamp, sha, cfghash = parts
    assert len(stamp) == 13 and stamp[8] == "-"
    assert sha
    assert len(cfghash) == 6


def test_different_config_gives_a_different_directory(config_file: Path, tmp_path: Path) -> None:
    first = make_run_id(_config(config_file, tmp_path))
    second = make_run_id(_config(config_file, tmp_path, **{"train.epochs": "11"}))
    assert first.split("_")[2] != second.split("_")[2]


def test_split_lock_records_digests(config_file: Path, tmp_path: Path) -> None:
    split = tmp_path / "train.txt"
    split.write_text("a\nb\n", encoding="utf-8")
    cfg = _config(config_file, tmp_path, **{"data.split_files": f"[{split}]"})
    run = create_run_dir(cfg)
    line = (run.path / SPLIT_LOCK_NAME).read_text(encoding="utf-8").strip()
    assert line.startswith(hashlib.sha256(b"a\nb\n").hexdigest())
    assert str(split) in line


def test_missing_split_is_marked_not_skipped(config_file: Path, tmp_path: Path) -> None:
    cfg = _config(config_file, tmp_path, **{"data.split_files": f"[{tmp_path / 'gone.txt'}]"})
    run = create_run_dir(cfg)
    assert "MISSING" in (run.path / SPLIT_LOCK_NAME).read_text(encoding="utf-8")


def test_a_branch_that_names_shard_ranges_still_records_its_split(
    config_file: Path, tmp_path: Path
) -> None:
    """Shard branches list no files, and every one of their runs locked nothing."""
    cfg = _config(
        config_file,
        tmp_path,
        **{"data.params.val_split": "test:0:10", "data.params.train_split": "train"},
    )
    written = (run := create_run_dir(cfg)).path / SPLIT_LOCK_NAME
    text = written.read_text(encoding="utf-8")
    assert "train_split: train" in text
    assert "val_split: test:0:10" in text
    assert run.path.is_dir()


def test_a_run_that_names_no_data_at_all_says_so(config_file: Path, tmp_path: Path) -> None:
    """An empty lock file reads as "not checked yet"; this has to read as a fault."""
    run = create_run_dir(_config(config_file, tmp_path))
    assert (run.path / SPLIT_LOCK_NAME).read_text(encoding="utf-8").strip() == "UNDECLARED"


def test_resolved_config_is_replayable(config_file: Path, tmp_path: Path) -> None:
    cfg = _config(config_file, tmp_path)
    run = create_run_dir(cfg)
    written = yaml.safe_load((run.path / CONFIG_NAME).read_text(encoding="utf-8"))
    assert written["model"]["input_hw"] == [8, 8]
    assert written["train"]["epochs"] == 2


def test_existing_directory_is_refused(config_file: Path, tmp_path: Path) -> None:
    cfg = _config(config_file, tmp_path)
    run = create_run_dir(cfg)
    with pytest.raises(FileExistsError):
        create_run_dir(cfg, now=_stamp_of(run.path.name))


def _stamp_of(name: str):
    from datetime import datetime

    return datetime.strptime(name.split("_")[0], "%Y%m%d-%H%M")
