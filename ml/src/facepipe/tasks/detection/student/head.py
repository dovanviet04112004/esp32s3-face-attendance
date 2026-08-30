"""Detection head: three branches per pyramid level.

The reference YuNet carries a fourth branch, objectness, and multiplies it with
the class score at inference. With a single class the two are redundant, and
every extra branch is three more tensors for decode.cpp to read on the device,
so the plan folds objectness into classification (KEHOACH section 4.4.3).
"""

from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import nn

from .blocks import ConvDPUnit, init_weights

LANDMARK_COUNT = 5
BBOX_COORDS = 4


@dataclass(frozen=True)
class HeadOutput:
    """Raw per-level predictions, before decoding into boxes."""

    cls: list[torch.Tensor]
    bbox: list[torch.Tensor]
    kps: list[torch.Tensor]


class YuNetHead(nn.Module):
    """One shared separable unit per level, then the three prediction branches."""

    def __init__(
        self,
        in_channels: int = 64,
        feat_channels: int = 64,
        num_levels: int = 3,
        num_classes: int = 1,
        shared_convs: int = 1,
    ) -> None:
        super().__init__()
        self.num_classes = num_classes
        self.shared = nn.ModuleList()
        self.cls = nn.ModuleList()
        self.bbox = nn.ModuleList()
        self.kps = nn.ModuleList()

        for _ in range(num_levels):
            stack = [
                ConvDPUnit(in_channels if i == 0 else feat_channels, feat_channels)
                for i in range(shared_convs)
            ]
            self.shared.append(nn.Sequential(*stack))
            branch_in = feat_channels if shared_convs else in_channels
            self.cls.append(ConvDPUnit(branch_in, num_classes, with_bn_relu=False))
            self.bbox.append(ConvDPUnit(branch_in, BBOX_COORDS, with_bn_relu=False))
            self.kps.append(ConvDPUnit(branch_in, LANDMARK_COUNT * 2, with_bn_relu=False))

        init_weights(self)

    def forward(self, feats: list[torch.Tensor]) -> HeadOutput:
        shared = [block(feat) for feat, block in zip(feats, self.shared, strict=True)]
        return HeadOutput(
            cls=[branch(feat) for feat, branch in zip(shared, self.cls, strict=True)],
            bbox=[branch(feat) for feat, branch in zip(shared, self.bbox, strict=True)],
            kps=[branch(feat) for feat, branch in zip(shared, self.kps, strict=True)],
        )
