"""YuNet student: backbone, TFPN neck, three-branch head.

Registered as "yunet" so a config selects it by name without core importing
this module (KEHOACH section 4.4.3).

Weights start random. Loading the reference checkpoint would make the ablation
in section 3.7 meaningless, because arm A0 would no longer be a student trained
without a teacher.
"""

from __future__ import annotations

import torch
from torch import nn
from torch.nn.functional import interpolate, max_pool2d

from facepipe.core.registry import MODELS

from .blocks import Conv4LayerBlock, ConvDPUnit, ConvHead, init_weights
from .head import HeadOutput, YuNetHead

STAGE_CHANNELS: tuple[tuple[int, ...], ...] = (
    (3, 16, 16),
    (16, 64),
    (64, 64),
    (64, 64),
    (64, 64),
    (64, 64),
)
DOWNSAMPLE_STAGES = (0, 2, 3, 4)
OUTPUT_STAGES = (3, 4, 5)
STRIDES = (8, 16, 32)


class YuNetBackbone(nn.Module):
    """Six stages, pooling between most of them, emitting the last three."""

    def __init__(
        self,
        stage_channels: tuple[tuple[int, ...], ...] = STAGE_CHANNELS,
        downsample_stages: tuple[int, ...] = DOWNSAMPLE_STAGES,
        output_stages: tuple[int, ...] = OUTPUT_STAGES,
    ) -> None:
        super().__init__()
        self.downsample_stages = downsample_stages
        self.output_stages = output_stages
        stages: list[nn.Module] = [ConvHead(*stage_channels[0])]
        stages += [Conv4LayerBlock(*channels) for channels in stage_channels[1:]]
        self.stages = nn.ModuleList(stages)
        init_weights(self)

    def forward(self, x: torch.Tensor) -> list[torch.Tensor]:
        feats = []
        for index, stage in enumerate(self.stages):
            x = stage(x)
            if index in self.output_stages:
                feats.append(x)
            if index in self.downsample_stages:
                x = max_pool2d(x, 2)
        return feats


class TinyFPN(nn.Module):
    """Top-down fusion, one separable unit per level.

    Upsampling targets the lower level's own size rather than doubling: at
    160x120 the levels are 15, 7 and 3 rows, and doubling 3 gives 6 where 7 is
    needed.
    """

    def __init__(self, channels: tuple[int, ...] = (64, 64, 64)) -> None:
        super().__init__()
        self.lateral = nn.ModuleList([ConvDPUnit(c, c) for c in channels])
        init_weights(self)

    def forward(self, feats: list[torch.Tensor]) -> list[torch.Tensor]:
        merged = list(feats)
        for level in range(len(merged) - 1, 0, -1):
            merged[level] = self.lateral[level](merged[level])
            upsampled = interpolate(
                merged[level], size=merged[level - 1].shape[-2:], mode="nearest"
            )
            merged[level - 1] = merged[level - 1] + upsampled
        merged[0] = self.lateral[0](merged[0])
        return merged


@MODELS.register("yunet")
class YuNet(nn.Module):
    """Face detector emitting class score, box offset and five landmarks."""

    def __init__(self, num_classes: int = 1, shared_convs: int = 1) -> None:
        super().__init__()
        self.strides = STRIDES
        self.backbone = YuNetBackbone()
        self.neck = TinyFPN()
        self.head = YuNetHead(
            num_levels=len(STRIDES), num_classes=num_classes, shared_convs=shared_convs
        )

    def forward(self, x: torch.Tensor) -> HeadOutput:
        return self.head(self.neck(self.backbone(x)))
