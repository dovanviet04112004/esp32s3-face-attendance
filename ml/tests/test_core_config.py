"""E2-T2 and E2-T8: config loads, merges, overrides, and drives input_hw."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from facepipe.core.config import (
    Config,
    apply_overrides,
    config_hash,
    dump_config,
    load_config,
    load_yaml_tree,
)


def test_loads_minimal_config(config_file: Path) -> None:
    cfg = load_config(config_file)
    assert cfg.run.task == "dummy"
    assert cfg.model.input_hw == (8, 8)
    assert cfg.train.epochs == 2


def test_unknown_key_is_rejected(tmp_path: Path, config_tree: dict) -> None:
    config_tree["train"]["epochsss"] = 3
    path = tmp_path / "typo.yaml"
    path.write_text(yaml.safe_dump(config_tree), encoding="utf-8")
    with pytest.raises(ValidationError):
        load_config(path)


def test_base_inheritance_merges_deeply(tmp_path: Path, config_tree: dict) -> None:
    base = tmp_path / "base.yaml"
    base.write_text(yaml.safe_dump(config_tree), encoding="utf-8")
    child = tmp_path / "child.yaml"
    child.write_text(
        yaml.safe_dump({"_base_": "base.yaml", "train": {"epochs": 7}}), encoding="utf-8"
    )
    cfg = load_config(child)
    assert cfg.train.epochs == 7
    assert cfg.optim.lr == pytest.approx(0.05)


def test_circular_base_is_reported(tmp_path: Path) -> None:
    a = tmp_path / "a.yaml"
    b = tmp_path / "b.yaml"
    a.write_text(yaml.safe_dump({"_base_": "b.yaml"}), encoding="utf-8")
    b.write_text(yaml.safe_dump({"_base_": "a.yaml"}), encoding="utf-8")
    with pytest.raises(ValueError, match="circular"):
        load_yaml_tree(a)


def test_cli_override_is_typed(config_file: Path) -> None:
    cfg = load_config(config_file, ["train.epochs=9", "model.input_hw=[16, 32]"])
    assert cfg.train.epochs == 9
    assert cfg.model.input_hw == (16, 32)


def test_override_rejects_malformed_item() -> None:
    with pytest.raises(ValueError, match="key=value"):
        apply_overrides({}, ["not-an-assignment"])


def test_input_hw_must_be_positive(tmp_path: Path, config_tree: dict) -> None:
    config_tree["model"]["input_hw"] = [0, 8]
    path = tmp_path / "bad.yaml"
    path.write_text(yaml.safe_dump(config_tree), encoding="utf-8")
    with pytest.raises(ValidationError):
        load_config(path)


def test_hash_tracks_content_not_key_order(config_file: Path) -> None:
    first = load_config(config_file)
    second = load_config(config_file, ["train.epochs=2"])
    changed = load_config(config_file, ["train.epochs=3"])
    assert config_hash(first) == config_hash(second)
    assert config_hash(first) != config_hash(changed)


def test_resolved_config_round_trips(tmp_path: Path, config_file: Path) -> None:
    cfg = load_config(config_file)
    target = tmp_path / "config.resolved.yaml"
    dump_config(cfg, target)
    again = Config.model_validate(yaml.safe_load(target.read_text(encoding="utf-8")))
    assert config_hash(again) == config_hash(cfg)
