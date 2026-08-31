"""Building blocks of the MobileFaceNet student.

Every spatial convolution is depthwise, which is what ESP-NN accelerates, and the
activation is PReLU throughout: a per-channel slope costs one multiply and keeps
the negative half of the distribution, which matters for a network whose output
is compared by angle rather than thresholded (KEHOACH section 3, layer 1).

The expand-filter-project shape is MobileNetV2's inverted residual. The width the
filter runs at is given as a channel count rather than a ratio, because that is
the number the kernel and the INT8 arena are sized from.
"""

from __future__ import annotations

import torch
from torch import nn


class ConvBnPrelu(nn.Module):
    """Convolution, batch norm, PReLU: the unit the whole backbone is built from."""

    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        kernel_size: int | tuple[int, int] = 1,
        stride: int = 1,
        padding: int | tuple[int, int] = 0,
        groups: int = 1,
    ) -> None:
        super().__init__()
        self.conv = nn.Conv2d(
            in_channels, out_channels, kernel_size, stride, padding, groups=groups, bias=False
        )
        self.bn = nn.BatchNorm2d(out_channels)
        self.act = nn.PReLU(out_channels)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.act(self.bn(self.conv(x)))


class ConvBn(nn.Module):
    """The same without an activation, for the layers that feed a residual add."""

    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        kernel_size: int | tuple[int, int] = 1,
        stride: int = 1,
        padding: int | tuple[int, int] = 0,
        groups: int = 1,
    ) -> None:
        super().__init__()
        self.conv = nn.Conv2d(
            in_channels, out_channels, kernel_size, stride, padding, groups=groups, bias=False
        )
        self.bn = nn.BatchNorm2d(out_channels)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.bn(self.conv(x))


class DepthWise(nn.Module):
    """Expand pointwise, filter depthwise, project back without an activation."""

    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        expand: int,
        kernel_size: int = 3,
        stride: int = 1,
        padding: int = 1,
    ) -> None:
        super().__init__()
        self.expand = ConvBnPrelu(in_channels, expand, kernel_size=1)
        self.filter = ConvBnPrelu(expand, expand, kernel_size, stride, padding, groups=expand)
        self.project = ConvBn(expand, out_channels, kernel_size=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.project(self.filter(self.expand(x)))


class Residual(nn.Module):
    """A stack of DepthWise blocks, each added back to its own input."""

    def __init__(
        self,
        channels: int,
        blocks: int,
        expand: int,
        kernel_size: int = 3,
        padding: int = 1,
    ) -> None:
        super().__init__()
        self.blocks = nn.ModuleList(
            DepthWise(channels, channels, expand, kernel_size, stride=1, padding=padding)
            for _ in range(blocks)
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        for block in self.blocks:
            x = x + block(x)
        return x
