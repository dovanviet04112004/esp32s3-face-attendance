"""Settings of the rPPG measurement, read from configs/rppg/rppg.yaml."""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, field_validator

ML_ROOT = Path(__file__).resolve().parents[4]
PATHS_FILE = ML_ROOT / "configs/common/paths.yaml"


class Region(BaseModel):
    """One skin patch, placed from the eye midpoint in units of the eye distance."""

    model_config = ConfigDict(extra="forbid")

    centre: tuple[float, float]
    size: tuple[float, float]


class BoardPath(BaseModel):
    """One simulated distance on the board: the face width it draws."""

    model_config = ConfigDict(extra="forbid")

    face_px: int


class RppgConfig(BaseModel):
    """Every knob of trace extraction and scoring; a typo fails at load."""

    model_config = ConfigDict(extra="forbid")

    detector_period_s: float
    edge: float
    regions: dict[str, Region]
    board_fps: float
    board_noise_lsb: float
    board_paths: dict[str, BoardPath]
    band_hz: tuple[float, float]
    peak_halfwidth_hz: float
    pos_window_s: float
    methods: list[str]
    windows_s: list[float]
    stride_s: float
    nfft: int
    target_bpcer: float
    seed: int

    @field_validator("methods")
    @classmethod
    def known_methods(cls, value: list[str]) -> list[str]:
        unknown = set(value) - {"green", "chrom", "pos"}
        if unknown:
            raise ValueError(f"unknown rPPG methods {sorted(unknown)}")
        return value


def load_config(path: Path) -> RppgConfig:
    return RppgConfig.model_validate(yaml.safe_load(Path(path).read_text(encoding="utf-8")))


def data_path(entry: str) -> Path:
    """One entry of configs/common/paths.yaml, as a path under ml/."""
    node = yaml.safe_load(PATHS_FILE.read_text(encoding="utf-8"))
    for key in entry.split("."):
        node = node[key]
    return ML_ROOT / node
