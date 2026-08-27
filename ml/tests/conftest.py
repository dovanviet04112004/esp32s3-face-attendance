"""Shared fixtures: a tiny config and a tiny model, so core can be tested alone."""

from __future__ import annotations

from pathlib import Path

import pytest
import torch
import yaml
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

MINIMAL_CONFIG = {
    "run": {"task": "dummy", "seed": 42, "artifacts_root": "artifacts"},
    "model": {"name": "tiny", "input_hw": [8, 8], "params": {"width": 4}},
    "data": {"name": "tensors", "batch_size": 4, "num_workers": 0},
    "train": {"epochs": 2, "amp": False, "log_every_steps": 1, "device": "cpu"},
    "optim": {"name": "sgd", "lr": 0.05},
    "sched": {"name": "cosine"},
}


@pytest.fixture
def config_tree() -> dict:
    return {k: dict(v) for k, v in MINIMAL_CONFIG.items()}


@pytest.fixture
def config_file(tmp_path: Path, config_tree: dict) -> Path:
    path = tmp_path / "run.yaml"
    path.write_text(yaml.safe_dump(config_tree), encoding="utf-8")
    return path


class TinyNet(nn.Module):
    """Two-layer net whose input size follows input_hw, for the E2-T8 check."""

    def __init__(self, input_hw: tuple[int, int] = (8, 8), width: int = 4, out_dim: int = 2):
        super().__init__()
        self.input_hw = tuple(input_hw)
        self.features = nn.Sequential(
            nn.Conv2d(1, width, 3, padding=1),
            nn.ReLU(),
            nn.AdaptiveAvgPool2d(1),
        )
        self.head = nn.Linear(width, out_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.head(self.features(x).flatten(1))


@pytest.fixture
def tiny_model() -> TinyNet:
    return TinyNet()


@pytest.fixture
def tiny_loader() -> DataLoader:
    generator = torch.Generator().manual_seed(0)
    images = torch.randn(16, 1, 8, 8, generator=generator)
    labels = torch.randint(0, 2, (16,), generator=generator)
    return DataLoader(TensorDataset(images, labels), batch_size=4, shuffle=False)
