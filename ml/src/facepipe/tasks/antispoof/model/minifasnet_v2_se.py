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
    """One view's feature extractor: the embedding, and the spatial map beside it."""

    def __init__(
        self,
        embedding: int = 128,
        squeeze_excite: bool = True,
        activation: str = "relu6",
        input_size: int = INPUT_SIZE,
        width: int = WIDTH,
        in_channels: int = 3,
        patch_supervision: bool = False,
    ) -> None:
        super().__init__()
        _stem, second, third, fourth = stage_maps(input_size)
        gate = {"squeeze_excite": squeeze_excite, "activation": activation}
        wide = width * 2
        closing = width * 8
        self.stem = ConvBnAct(
            in_channels, width, 3, stride=2, padding=1, activation=activation
        )
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
        # Dropped at export: the local decisions only shape training (KEHOACH 3).
        self.patch = nn.Conv2d(closing, 1, kernel_size=1) if patch_supervision else None

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor | None]:
        x = self.stem_dw(self.stem(x))
        x = self.stage_2(self.down_2(x))
        x = self.stage_3(self.down_3(x))
        x = self.stage_4(self.down_4(x))
        mapped = self.head(x)
        flat = torch.flatten(self.head_dw(mapped), 1)
        patch = self.patch(mapped) if self.patch is not None and self.training else None
        return self.embed_bn(self.embed(flat)), patch


class Reverse(torch.autograd.Function):
    """Identity going forward, sign flipped coming back: one head, two goals."""

    @staticmethod
    def forward(ctx, x: torch.Tensor, scale: float) -> torch.Tensor:
        ctx.scale = scale
        return x.view_as(x)

    @staticmethod
    def backward(ctx, grad: torch.Tensor):
        return -ctx.scale * grad, None


@MODELS.register("minifasnet_v2_se")
class MiniFASNetV2SE(nn.Module):
    """Anti-spoof classifier over the face crop, with an optional context backbone.

    forward takes the views as one tuple because the shared trainer hands every
    model a single input; views="tight" keeps only the face backbone. Under
    patch_supervision it also returns the spatial map, but only while training.
    """

    def __init__(
        self,
        num_classes: int = 2,
        embedding: int = 128,
        squeeze_excite: bool = True,
        activation: str = "relu6",
        input_size: int = INPUT_SIZE,
        width: int = WIDTH,
        views: str = "tight",
        chroma: bool = False,
        patch_supervision: bool = False,
        domains: int = 0,
    ) -> None:
        super().__init__()
        if views not in ("tight", "both"):
            raise ValueError(f"views must be 'tight' or 'both', got {views!r}")
        self.views = views
        self.chroma = chroma
        planes = 4 if chroma else 3
        self.tight = MiniFASNetBackbone(
            embedding, squeeze_excite, activation, input_size, width, planes, patch_supervision
        )
        self.wide = (
            MiniFASNetBackbone(
                embedding, squeeze_excite, activation, input_size, width, planes
            )
            if views == "both"
            else None
        )
        self.drop = nn.Dropout(p=0.2)
        width_out = embedding * (2 if views == "both" else 1)
        self.classifier = nn.Linear(width_out, num_classes)
        # Reached through a sign flip, so the trunk learns to defeat it and the
        # live half stops carrying which camera took it (KEHOACH 3, SSDG).
        self.domain = nn.Linear(width_out, domains) if domains > 1 else None

    def forward(
        self, views: torch.Tensor | tuple[torch.Tensor, torch.Tensor]
    ) -> torch.Tensor | tuple[torch.Tensor, torch.Tensor]:
        tight = views[0] if isinstance(views, (tuple, list)) else views
        features, patch = self.tight(tight)
        if self.wide is not None:
            features = torch.cat((features, self.wide(views[1])[0]), dim=1)
        logits = self.classifier(self.drop(features))
        if not self.training or (patch is None and self.domain is None):
            return logits
        told = self.domain(Reverse.apply(features, 1.0)) if self.domain is not None else None
        return logits, patch, features, told
