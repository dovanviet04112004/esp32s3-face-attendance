"""Shared fixtures: a tiny config and a tiny model, so core can be tested alone.

The ESP-DL ladder's tests share LadderNet, quantised by ESP-PPQ as the ladder quantises a run.
"""

from __future__ import annotations

from dataclasses import dataclass
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


class LadderNet(nn.Module):
    """Two outputs over the ops the ESP-DL ladder meets most: convolutions, a residual, a head."""

    def __init__(self) -> None:
        super().__init__()
        self.stem = nn.Conv2d(3, 16, 3, stride=2, padding=1)
        self.body = nn.Conv2d(16, 16, 3, padding=1)
        self.head = nn.Linear(16, 8)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        y = torch.relu(self.stem(x))
        y = torch.relu(y + self.body(y))
        return self.head(torch.flatten(nn.functional.adaptive_avg_pool2d(y, 1), 1)), y


@dataclass
class Quantised:
    """A LadderNet as ESP-PPQ quantised it, with the calibration and rungs it took."""

    model: LadderNet
    graph: object
    calib: list[torch.Tensor]
    rungs: dict


def ladder_calibration(batch: int = 1, count: int = 8, seed: int = 1) -> list[torch.Tensor]:
    generator = torch.Generator().manual_seed(seed)
    return [torch.rand(batch, 3, 16, 16, generator=generator) for _ in range(count)]


def ladder_onnx(model: nn.Module, out: Path, feed: torch.Tensor) -> Path:
    """A LadderNet as the ONNX the ladder quantises, traced at feed's batch."""
    from facepipe.export import to_onnx

    torch.onnx.export(
        model.eval(),
        (feed,),
        str(out),
        opset_version=to_onnx.OPSET,
        input_names=["image"],
        output_names=["vector", "map"],
        dynamo=False,
    )
    return out


def quantise_ladder_net(model: nn.Module, work: Path, calib: list[torch.Tensor], rungs: dict):
    """model through ONNX, traced at calib's batch, into the graph ESP-PPQ gives for the S3."""
    from facepipe.compress.quant import ptq_espdl

    work.mkdir(parents=True, exist_ok=True)
    onnx_path = ladder_onnx(model, work / "net.onnx", calib[0])
    return ptq_espdl.quantize_onnx(onnx_path, calib, work, rungs)


@pytest.fixture(scope="session")
def ladder_graph(tmp_path_factory: pytest.TempPathFactory) -> Quantised:
    """One LadderNet under the default rungs, shared: tests read it and never change it."""
    pytest.importorskip("esp_ppq")
    from facepipe.compress.quant import ptq_espdl

    torch.manual_seed(0)
    model = LadderNet().eval()
    calib = ladder_calibration()
    rungs = ptq_espdl.ladder("recognition")
    graph = quantise_ladder_net(model, tmp_path_factory.mktemp("ladder"), calib, rungs)
    return Quantised(model, graph, calib, rungs)
