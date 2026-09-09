"""MobileFaceNet: the recognition model that ships on the device.

It closes on a global depthwise convolution rather than average pooling, so an
aligned face's corners can weigh less than its centre. That kernel matches what
the four downsamples leave, so it is derived: input 113 leaves 8x8, and 113 is
also the size that folds every PAD away (KEHOACH 3 layer 1).
"""

from __future__ import annotations

import torch
from torch import nn

from facepipe.core.registry import MODELS

from .blocks import ConvBn, ConvBnAct, DepthWise, Residual

INPUT_SIZE = 113
DOWNSAMPLES = 4


def final_map(input_size: int) -> int:
    """What the four stride-2 convolutions leave for the closing kernel."""
    size = input_size
    for _ in range(DOWNSAMPLES):
        size = (size + 2 - 3) // 2 + 1
    return size


FINAL_MAP = final_map(INPUT_SIZE)


@MODELS.register("mobilefacenet")
class MobileFaceNet(nn.Module):
    """Four stages of inverted residuals closed by a global depthwise convolution."""

    def __init__(
        self,
        embedding: int = 512,
        width: int = 64,
        activation: str = "relu6",
        input_size: int = INPUT_SIZE,
    ) -> None:
        super().__init__()
        act = {"activation": activation}
        self.stem = ConvBnAct(3, width, kernel_size=3, stride=2, padding=1, **act)
        self.stem_dw = ConvBnAct(width, width, 3, stride=1, padding=1, groups=width, **act)

        self.down_2 = DepthWise(width, width, expand=width * 2, stride=2, **act)
        self.stage_2 = Residual(width, blocks=4, expand=width * 2, **act)
        self.down_3 = DepthWise(width, width * 2, expand=width * 4, stride=2, **act)
        self.stage_3 = Residual(width * 2, blocks=6, expand=width * 4, **act)
        self.down_4 = DepthWise(width * 2, width * 2, expand=width * 8, stride=2, **act)
        self.stage_4 = Residual(width * 2, blocks=2, expand=width * 4, **act)

        self.head = ConvBnAct(width * 2, 512, kernel_size=1, **act)
        self.head_dw = ConvBn(512, 512, kernel_size=final_map(input_size), groups=512)
        self.embed = nn.Linear(512, embedding, bias=False)
        # No affine: the embedding is compared by angle, so a learned per-channel
        # scale would only rescale a vector that is normalised straight after.
        self.embed_bn = nn.BatchNorm1d(embedding, affine=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.stem_dw(self.stem(x))
        x = self.stage_2(self.down_2(x))
        x = self.stage_3(self.down_3(x))
        x = self.stage_4(self.down_4(x))
        x = self.head_dw(self.head(x))
        return self.embed_bn(self.embed(torch.flatten(x, 1)))
