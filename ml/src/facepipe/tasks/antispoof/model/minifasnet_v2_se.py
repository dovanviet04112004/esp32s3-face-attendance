"""MiniFASNetV2-SE: the anti-spoof model that ships on the device.

Two crops of one face, tight and 2.7x context, on separate weights, concatenated
before the classifier (KEHOACH 1.1). Input is 81x81 per view, odd at every
downsample so no padding becomes its own operator, and the map each stage
leaves is derived so the closing kernel and the SE windows follow it.
"""

from __future__ import annotations

import torch
from torch import nn

from facepipe.core.registry import MODELS

from .blocks import ConvBn, ConvBnAct, DepthWise, Residual

INPUT_SIZE = 81
DOWNSAMPLES = 4
# Every channel is a multiple of this, so it stays a multiple of 8 (KEHOACH 3).
WIDTH = 32


def stage_maps(input_size: int) -> list[int]:
    """Feature map after each stride-2 convolution, the stem included."""
    sizes = []
    size = input_size
    for _ in range(DOWNSAMPLES):
        size = (size + 2 - 3) // 2 + 1
        sizes.append(size)
    return sizes


FINAL_MAP = stage_maps(INPUT_SIZE)[-1]


class MiniFASNetBackbone(nn.Module):
    """One view's feature extractor, ending in an embedding rather than a class."""

    def __init__(
        self,
        embedding: int = 128,
        squeeze_excite: bool = True,
        activation: str = "relu6",
        input_size: int = INPUT_SIZE,
        width: int = WIDTH,
    ) -> None:
        super().__init__()
        _stem, second, third, fourth = stage_maps(input_size)
        gate = {"squeeze_excite": squeeze_excite, "activation": activation}
        wide = width * 2
        closing = width * 8
        self.stem = ConvBnAct(3, width, 3, stride=2, padding=1, activation=activation)
        self.stem_dw = ConvBnAct(
            width, width, 3, stride=1, padding=1, groups=width, activation=activation
        )

        self.down_2 = DepthWise(width, width, wide, second, stride=2, **gate)
        self.stage_2 = Residual(width, blocks=2, expand=wide, map_size=second, **gate)
        self.down_3 = DepthWise(width, wide, width * 4, third, stride=2, **gate)
        self.stage_3 = Residual(wide, blocks=3, expand=width * 4, map_size=third, **gate)
        self.down_4 = DepthWise(wide, wide, closing, fourth, stride=2, **gate)
        self.stage_4 = Residual(wide, blocks=2, expand=width * 4, map_size=fourth, **gate)

        self.head = ConvBnAct(wide, closing, kernel_size=1, activation=activation)
        self.head_dw = ConvBn(closing, closing, kernel_size=fourth, groups=closing)
        self.embed = nn.Linear(closing, embedding, bias=False)
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

    forward takes the two crops as one pair, not two arguments, because the
    shared distiller calls every model with a single input. Feeding the same
    crop twice trains a model that cannot use context.
    """

    def __init__(
        self,
        num_classes: int = 2,
        embedding: int = 128,
        squeeze_excite: bool = True,
        activation: str = "relu6",
        input_size: int = INPUT_SIZE,
        width: int = WIDTH,
    ) -> None:
        super().__init__()
        self.tight = MiniFASNetBackbone(embedding, squeeze_excite, activation, input_size, width)
        self.wide = MiniFASNetBackbone(embedding, squeeze_excite, activation, input_size, width)
        self.drop = nn.Dropout(p=0.2)
        self.classifier = nn.Linear(embedding * 2, num_classes)

    def forward(self, views: tuple[torch.Tensor, torch.Tensor]) -> torch.Tensor:
        tight, wide = views
        joined = torch.cat((self.tight(tight), self.wide(wide)), dim=1)
        return self.classifier(self.drop(joined))
