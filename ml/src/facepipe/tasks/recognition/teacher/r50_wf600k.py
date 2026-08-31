"""The recognition teacher: ArcFace ResNet50 trained on WebFace600K, frozen.

This is the backbone of InsightFace's buffalo_l pack, and nothing here trains it.
It exists to answer one question 5.1 million times - where does this face sit on
the unit sphere - and export_embedding.py caches those answers so the KD arm pays
the cost once instead of once per epoch.

The architecture is arcface_torch's IResNet: batch norm before each convolution
rather than after, PReLU throughout, and a fully connected layer over the whole
7x7 final map instead of pooling it. The published weights have every batch norm
that follows a convolution folded into that convolution's bias, so the blocks
here carry only the batch norms that precede one - the shape the checkpoint has,
not the shape the paper draws.

Input is 112x112 RGB scaled to [-1, 1], the same alignment postproc/align.py
produces. Feeding it anything else returns embeddings that are stable, plausible
and wrong.
"""

from __future__ import annotations

from pathlib import Path

import torch
from torch import nn

from facepipe.core.registry import TEACHERS

INPUT_SIZE = 112
EMBEDDING_DIM = 512
PIXEL_MEAN = 127.5
PIXEL_SCALE = 127.5
BN_EPS = 1e-5


class IBasicBlock(nn.Module):
    """Pre-activation residual block: norm, convolve, activate, convolve, add."""

    def __init__(self, in_channels: int, channels: int, stride: int = 1) -> None:
        super().__init__()
        self.bn1 = nn.BatchNorm2d(in_channels, eps=BN_EPS)
        self.conv1 = nn.Conv2d(in_channels, channels, 3, 1, 1, bias=True)
        self.prelu = nn.PReLU(channels)
        self.conv2 = nn.Conv2d(channels, channels, 3, stride, 1, bias=True)
        self.downsample = (
            nn.Conv2d(in_channels, channels, 1, stride, bias=True)
            if stride != 1 or in_channels != channels
            else None
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = self.conv2(self.prelu(self.conv1(self.bn1(x))))
        identity = x if self.downsample is None else self.downsample(x)
        return out + identity


class IResNet(nn.Module):
    """The teacher backbone, emitting an unnormalised 512-D embedding."""

    def __init__(
        self,
        layers: tuple[int, int, int, int] = (3, 4, 14, 3),
        channels: tuple[int, int, int, int] = (64, 128, 256, 512),
        embedding: int = EMBEDDING_DIM,
        input_size: int = INPUT_SIZE,
    ) -> None:
        super().__init__()
        self.conv1 = nn.Conv2d(3, channels[0], 3, 1, 1, bias=True)
        self.prelu = nn.PReLU(channels[0])

        stages = []
        in_channels = channels[0]
        for count, width in zip(layers, channels, strict=True):
            blocks = [IBasicBlock(in_channels, width, stride=2)]
            blocks += [IBasicBlock(width, width) for _ in range(count - 1)]
            stages.append(nn.Sequential(*blocks))
            in_channels = width
        self.layer1, self.layer2, self.layer3, self.layer4 = stages

        self.bn1 = nn.BatchNorm2d(channels[-1], eps=BN_EPS)
        final_map = input_size // 2**4
        self.fc = nn.Linear(channels[-1] * final_map * final_map, embedding)
        self.features = nn.BatchNorm1d(embedding, eps=BN_EPS)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.prelu(self.conv1(x))
        x = self.layer4(self.layer3(self.layer2(self.layer1(x))))
        x = self.bn1(x)
        return self.features(self.fc(torch.flatten(x, 1)))


def normalize_pixels(images: torch.Tensor) -> torch.Tensor:
    """Scale 0..255 RGB into the [-1, 1] range the published weights expect."""
    return (images - PIXEL_MEAN) / PIXEL_SCALE


@TEACHERS.register("r50_wf600k")
def load_r50_wf600k(weights: str | Path | None = None, strict: bool = True) -> IResNet:
    """Build the teacher and load the published checkpoint into it.

    Loading strictly is the point: a key that does not line up means the
    architecture here has drifted from the one the weights were trained in, and a
    teacher assembled from a partial load produces embeddings that look like
    embeddings and teach nothing.
    """
    model = IResNet()
    if weights is not None:
        state = torch.load(Path(weights), map_location="cpu", weights_only=True)
        model.load_state_dict(state, strict=strict)
    return model.eval()


@TEACHERS.register("cached_embedding")
class CachedEmbedding(nn.Module):
    """Stands in for the teacher when its answers were computed ahead of time.

    The lookup itself belongs to the loader, which reads the memmap in worker
    processes alongside the images; running it here would put a 5 GB random-access
    read on the training process. What is left is the conversion the cache's half
    precision needs before a loss can use it.
    """

    def forward(self, cached: torch.Tensor) -> torch.Tensor:
        return cached.float()
