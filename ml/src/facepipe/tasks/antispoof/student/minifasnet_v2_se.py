"""MiniFASNetV2-SE: the anti-spoof model that ships on the device.

It reads two crops of the same face, a tight one and a 2.7x context one, because
what separates a live face from a photograph is mostly outside the face: a screen
bezel, a paper edge, a hand holding the print. The two views share no weights;
their embeddings are concatenated before the classifier (KEHOACH section 1.1).

Input is 80x80 per view. The 5x5 depthwise layer that closes the backbone
consumes exactly the 5x5 map that size produces, so changing the input size
without changing that kernel silently changes what the classifier sees.
"""

from __future__ import annotations

import torch
from torch import nn

from facepipe.core.registry import MODELS

from .blocks import ConvBn, ConvBnPrelu, DepthWise, Residual

INPUT_SIZE = 80
FINAL_MAP = 5


class MiniFASNetBackbone(nn.Module):
    """One view's feature extractor, ending in an embedding rather than a class."""

    def __init__(self, embedding: int = 128, squeeze_excite: bool = True) -> None:
        super().__init__()
        self.stem = ConvBnPrelu(3, 32, kernel_size=3, stride=2, padding=1)
        self.stem_dw = ConvBnPrelu(32, 32, kernel_size=3, stride=1, padding=1, groups=32)

        self.down_2 = DepthWise(32, 32, expand=64, stride=2, squeeze_excite=squeeze_excite)
        self.stage_2 = Residual(32, blocks=2, expand=64, squeeze_excite=squeeze_excite)
        self.down_3 = DepthWise(32, 64, expand=128, stride=2, squeeze_excite=squeeze_excite)
        self.stage_3 = Residual(64, blocks=3, expand=128, squeeze_excite=squeeze_excite)
        self.down_4 = DepthWise(64, 64, expand=256, stride=2, squeeze_excite=squeeze_excite)
        self.stage_4 = Residual(64, blocks=2, expand=128, squeeze_excite=squeeze_excite)

        self.head = ConvBnPrelu(64, 256, kernel_size=1)
        self.head_dw = ConvBn(256, 256, kernel_size=FINAL_MAP, groups=256)
        self.embed = nn.Linear(256, embedding, bias=False)
        self.embed_bn = nn.BatchNorm1d(embedding)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.stem_dw(self.stem(x))
        x = self.stage_2(self.down_2(x))
        x = self.stage_3(self.down_3(x))
        x = self.stage_4(self.down_4(x))
        x = self.head_dw(self.head(x))
        return self.embed_bn(self.embed(torch.flatten(x, 1)))


@MODELS.register("minifasnet_v2_se")
class MiniFASNetV2SE(nn.Module):
    """Two-scale anti-spoof classifier.

    forward takes the two crops as one pair rather than two arguments, because
    the shared distiller calls every student with a single input. Feeding the
    same crop twice trains a model that cannot use context, which is the signal
    the branch exists to read.
    """

    def __init__(
        self, num_classes: int = 2, embedding: int = 128, squeeze_excite: bool = True
    ) -> None:
        super().__init__()
        self.tight = MiniFASNetBackbone(embedding, squeeze_excite)
        self.wide = MiniFASNetBackbone(embedding, squeeze_excite)
        self.drop = nn.Dropout(p=0.2)
        self.classifier = nn.Linear(embedding * 2, num_classes)

    def forward(self, views: tuple[torch.Tensor, torch.Tensor]) -> torch.Tensor:
        tight, wide = views
        joined = torch.cat((self.tight(tight), self.wide(wide)), dim=1)
        return self.classifier(self.drop(joined))
