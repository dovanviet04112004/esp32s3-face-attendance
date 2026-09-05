"""MobileFaceNet: the recognition model that ships on the device.

It closes on a global depthwise convolution rather than average pooling, so an
aligned face's corner cells can weigh less than its centre. Input is 112x112,
which makes the final map 7x7 and fixes that kernel at 7: change one without the
other and the embedding is computed from something else. Output is unnormalised.
"""

from __future__ import annotations

import torch
from torch import nn

from facepipe.core.registry import MODELS

from .blocks import ConvBn, ConvBnPrelu, DepthWise, Residual

INPUT_SIZE = 112
FINAL_MAP = 7


@MODELS.register("mobilefacenet")
class MobileFaceNet(nn.Module):
    """Four stages of inverted residuals closed by a global depthwise convolution."""

    def __init__(self, embedding: int = 512, width: int = 64) -> None:
        super().__init__()
        self.stem = ConvBnPrelu(3, width, kernel_size=3, stride=2, padding=1)
        self.stem_dw = ConvBnPrelu(width, width, kernel_size=3, stride=1, padding=1, groups=width)

        self.down_2 = DepthWise(width, width, expand=width * 2, stride=2)
        self.stage_2 = Residual(width, blocks=4, expand=width * 2)
        self.down_3 = DepthWise(width, width * 2, expand=width * 4, stride=2)
        self.stage_3 = Residual(width * 2, blocks=6, expand=width * 4)
        self.down_4 = DepthWise(width * 2, width * 2, expand=width * 8, stride=2)
        self.stage_4 = Residual(width * 2, blocks=2, expand=width * 4)

        self.head = ConvBnPrelu(width * 2, 512, kernel_size=1)
        self.head_dw = ConvBn(512, 512, kernel_size=FINAL_MAP, groups=512)
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
