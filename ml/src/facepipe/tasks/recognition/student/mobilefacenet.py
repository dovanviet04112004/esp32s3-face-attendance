"""MobileFaceNet: the recognition model that ships on the device.

Its one departure from a MobileNet is the last layer. A classifier ends in global
average pooling, which weighs every cell of the final map equally; on an aligned
face the corner cells are background and the centre cells are the nose, so equal
weighting throws away the only spatial structure alignment created. This ends in
a global depthwise convolution instead: one learned weight per cell per channel,
same output shape, and the layer can decide the corners matter less.

Input is 112x112 aligned by the five landmarks the detector produces, which makes
the final map 7x7 and fixes the depthwise kernel at 7. Changing the input size
without changing that kernel changes what the embedding is computed from.

The output is an unnormalised 512-D embedding. Normalising is the caller's job
and is done the same way in postproc/l2norm.py and on the device.
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
