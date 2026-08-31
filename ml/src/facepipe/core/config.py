"""Typed configuration: pydantic schema, YAML inheritance, CLI overrides.

Every knob a run depends on lives here and is written back out as
config.resolved.yaml, so a run directory alone is enough to reproduce the run.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator

BASE_KEY = "_base_"


class Section(BaseModel):
    """Base for every config section: unknown keys are an error, not a typo that survives."""

    model_config = ConfigDict(extra="forbid", validate_assignment=True)


class RunSection(Section):
    task: str = Field(description="Branch name; picks the artifacts subtree, never behaviour")
    seed: int = 42
    deterministic: bool = True
    cudnn_benchmark: bool = False
    artifacts_root: Path = Path("artifacts")
    tags: list[str] = Field(default_factory=list)
    notes: str = ""


class ModelSection(Section):
    name: str
    input_hw: tuple[int, int] = Field(description="Network input as (height, width) in pixels")
    params: dict[str, Any] = Field(default_factory=dict)
    ckpt: Path | None = None

    @field_validator("input_hw")
    @classmethod
    def _positive(cls, value: tuple[int, int]) -> tuple[int, int]:
        if value[0] <= 0 or value[1] <= 0:
            raise ValueError(f"input_hw must be positive, got {value}")
        return value


class TeacherSection(Section):
    enabled: bool = False
    name: str | None = None
    ckpt: Path | None = None
    input_hw: tuple[int, int] | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    freeze: bool = True


class DataSection(Section):
    name: str
    batch_size: int = 32
    num_workers: int = 8
    pin_memory: bool = True
    drop_last: bool = True
    split_files: list[Path] = Field(default_factory=list)
    params: dict[str, Any] = Field(default_factory=dict)


class OptimSection(Section):
    name: str = "sgd"
    lr: float = 0.1
    weight_decay: float = 5e-4
    params: dict[str, Any] = Field(default_factory=dict)


class SchedSection(Section):
    name: str = "cosine"
    warmup_epochs: int = 0
    min_lr: float = 0.0
    params: dict[str, Any] = Field(default_factory=dict)


class TrainSection(Section):
    epochs: int = 1
    amp: bool = True
    amp_dtype: Literal["float16", "bfloat16"] = "float16"
    ema_decay: float = 0.0
    grad_clip_norm: float = 0.0
    accum_steps: int = 1
    log_every_steps: int = 50
    ckpt_every_epochs: int = 1
    val_every_epochs: int = 1
    resume: Path | None = None
    device: str = "auto"
    # Both change which kernels run, so an ablation row only compares against
    # one that resolved them the same way (KEHOACH section 3.7).
    compile: bool | str = False
    channels_last: bool = False

    @field_validator("accum_steps")
    @classmethod
    def _at_least_one(cls, value: int) -> int:
        if value < 1:
            raise ValueError(f"accum_steps must be >= 1, got {value}")
        return value


class LossSpec(Section):
    name: str
    weight: float = 1.0
    params: dict[str, Any] = Field(default_factory=dict)


class StageSpec(Section):
    """One phase of a progressive schedule: which terms are on, and how strongly."""

    epochs: int = Field(gt=0)
    losses: list[str] = Field(default_factory=list)
    task_loss_weight: float = 1.0


class DistillSection(Section):
    enabled: bool = False
    losses: list[LossSpec] = Field(default_factory=list)
    feature_layers: list[str] = Field(default_factory=list)
    task_loss_weight: float = 1.0
    stages: list[StageSpec] = Field(default_factory=list)


class LogSection(Section):
    tensorboard: bool = True
    wandb: bool = False
    wandb_project: str = "facepipe"
    level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"


class Config(Section):
    """The whole resolved configuration of one run."""

    run: RunSection
    model: ModelSection
    data: DataSection
    train: TrainSection = Field(default_factory=TrainSection)
    optim: OptimSection = Field(default_factory=OptimSection)
    sched: SchedSection = Field(default_factory=SchedSection)
    teacher: TeacherSection = Field(default_factory=TeacherSection)
    distill: DistillSection = Field(default_factory=DistillSection)
    log: LogSection = Field(default_factory=LogSection)
    quant: dict[str, Any] = Field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Plain JSON-safe dict, the form written to config.resolved.yaml."""
        return json.loads(self.model_dump_json())


def _deep_merge(base: Mapping[str, Any], patch: Mapping[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in patch.items():
        current = out.get(key)
        if isinstance(current, Mapping) and isinstance(value, Mapping):
            out[key] = _deep_merge(current, value)
        else:
            out[key] = value
    return out


def load_yaml_tree(path: Path, _seen: tuple[Path, ...] = ()) -> dict[str, Any]:
    """Read a YAML file and splice in whatever `_base_` points at.

    `_base_` takes a path or a list of paths, resolved against the including
    file. Later entries win, and the including file wins over all of them.
    """
    path = path.resolve()
    if path in _seen:
        chain = " -> ".join(str(p) for p in (*_seen, path))
        raise ValueError(f"circular _base_ chain: {chain}")
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(raw, dict):
        raise TypeError(f"{path}: top level must be a mapping, got {type(raw).__name__}")

    bases = raw.pop(BASE_KEY, [])
    if isinstance(bases, str):
        bases = [bases]
    merged: dict[str, Any] = {}
    for base in bases:
        merged = _deep_merge(merged, load_yaml_tree(path.parent / base, (*_seen, path)))
    return _deep_merge(merged, raw)


def _coerce(text: str) -> Any:
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError:
        return text


def apply_overrides(tree: dict[str, Any], overrides: Iterable[str]) -> dict[str, Any]:
    """Apply `a.b.c=value` strings on top of a config tree.

    Values go through the YAML scalar parser, so `train.epochs=2` is an int and
    `run.tags=[a,b]` is a list.
    """
    out = dict(tree)
    for item in overrides:
        if "=" not in item:
            raise ValueError(f"override must be key=value, got {item!r}")
        dotted, _, raw = item.partition("=")
        keys = [k for k in dotted.strip().split(".") if k]
        if not keys:
            raise ValueError(f"override has an empty key: {item!r}")
        cursor = out
        for key in keys[:-1]:
            nxt = cursor.get(key)
            cursor[key] = dict(nxt) if isinstance(nxt, Mapping) else {}
            cursor = cursor[key]
        cursor[keys[-1]] = _coerce(raw)
    return out


def load_config(path: str | Path, overrides: Iterable[str] | None = None) -> Config:
    """Load, merge, override and validate a config file."""
    tree = load_yaml_tree(Path(path))
    if overrides:
        tree = apply_overrides(tree, overrides)
    return Config.model_validate(tree)


def config_hash(cfg: Config, length: int = 6) -> str:
    """Short stable digest of the resolved config, used in the run directory name."""
    payload = json.dumps(cfg.to_dict(), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:length]


def dump_config(cfg: Config, path: Path) -> None:
    """Write config.resolved.yaml."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = yaml.safe_dump(cfg.to_dict(), sort_keys=True, allow_unicode=True)
    path.write_text(text, encoding="utf-8")
