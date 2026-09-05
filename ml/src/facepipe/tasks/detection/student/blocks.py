"""Building blocks of the YuNet student.

Every convolution is separable and every activation ReLU6: ESP-NN accelerates
depthwise and pointwise convolutions, and ReLU6 bounds the activation range so
INT8 covers it without clipping a tail (KEHOACH 3, layer 1).
"""

from __future__ import annotations

import torch
from torch import nn


class ConvDPUnit(nn.Module):
    """Pointwise convolution followed by a depthwise one, optionally BN + ReLU6.

    The pointwise-then-depthwise order is YuNet's own and is kept: reversing it
    changes the parameter count and breaks weight compatibility with the
    reference checkpoints.
    """

    def __init__(self, in_channels: int, out_channels: int, with_bn_relu: bool = True) -> None:
        super().__init__()
        self.pointwise = nn.Conv2d(in_channels, out_channels, kernel_size=1, bias=True)
        self.depthwise = nn.Conv2d(
            out_channels, out_channels, kernel_size=3, padding=1, groups=out_channels, bias=True
        )
        self.norm = nn.BatchNorm2d(out_channels) if with_bn_relu else None
        self.act = nn.ReLU6(inplace=True) if with_bn_relu else None

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.depthwise(self.pointwise(x))
        if self.norm is not None and self.act is not None:
            x = self.act(self.norm(x))
        return x


class ConvHead(nn.Module):
    """Stem: a strided 3x3 convolution, then one separable unit."""

    def __init__(self, in_channels: int, mid_channels: int, out_channels: int) -> None:
        super().__init__()
        self.conv = nn.Conv2d(in_channels, mid_channels, kernel_size=3, stride=2, padding=1)
        self.norm = nn.BatchNorm2d(mid_channels)
        self.act = nn.ReLU6(inplace=True)
        self.unit = ConvDPUnit(mid_channels, out_channels)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.unit(self.act(self.norm(self.conv(x))))


class Conv4LayerBlock(nn.Module):
    """One backbone stage: two separable units, the first keeping the width."""

    def __init__(self, in_channels: int, out_channels: int, with_bn_relu: bool = True) -> None:
        super().__init__()
        self.unit1 = ConvDPUnit(in_channels, in_channels)
        self.unit2 = ConvDPUnit(in_channels, out_channels, with_bn_relu)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.unit2(self.unit1(x))


def init_weights(module: nn.Module) -> None:
    """Kaiming-normal on convolutions, unit scale and zero shift on norms."""
    for layer in module.modules():
        if isinstance(layer, nn.Conv2d):
            nn.init.kaiming_normal_(layer.weight, mode="fan_out", nonlinearity="relu")
            if layer.bias is not None:
                nn.init.zeros_(layer.bias)
        elif isinstance(layer, nn.BatchNorm2d):
            nn.init.ones_(layer.weight)
            nn.init.zeros_(layer.bias)
