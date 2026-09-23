"""MobileFaceNet-ECA as FRBench publishes it, so its trained weights load unchanged.

Architecture and parameter names follow HKU-TASR/FRBench `backbone/mobilefacenet.py`,
MIT License, Copyright (c) 2026 HKU Trustworthy AI and Systems Research (TASR) Lab,
itself after cavalleria/cavaface. The one departure: ECA multiplies by broadcast,
because the `Expand` that `expand_as` exports has no ESP-DL module (KEHOACH 3).
"""

from __future__ import annotations

import math

import torch
from torch import nn

from facepipe.core.registry import MODELS

INPUT_SIZE = 112
FINAL_MAP = 7


class ECAModule(nn.Module):
    """Channel weights from a 1-D convolution across the pooled channels."""

    def __init__(self, channels: int, gamma: int = 2, b: int = 1) -> None:
        super().__init__()
        t = int(abs((math.log2(channels) + b) / gamma))
        k = max(t if t % 2 else t + 1, 3)
        self.avg_pool = nn.AdaptiveAvgPool2d(1)
        self.conv = nn.Conv1d(1, 1, kernel_size=k, padding=k // 2, bias=False)
        self.sigmoid = nn.Sigmoid()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.avg_pool(x).squeeze(-1).transpose(-1, -2)
        y = self.conv(y).transpose(-1, -2).unsqueeze(-1)
        return x * self.sigmoid(y)


class ConvBlock(nn.Module):
    def __init__(
        self,
        cin: int,
        cout: int,
        kernel_size=(1, 1),
        stride=(1, 1),
        padding=(0, 0),
        groups: int = 1,
    ) -> None:
        super().__init__()
        self.conv = nn.Conv2d(cin, cout, kernel_size, stride, padding, groups=groups, bias=False)
        self.bn = nn.BatchNorm2d(cout)
        self.prelu = nn.PReLU(cout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.prelu(self.bn(self.conv(x)))


class LinearBlock(nn.Module):
    def __init__(
        self,
        cin: int,
        cout: int,
        kernel_size=(1, 1),
        stride=(1, 1),
        padding=(0, 0),
        groups: int = 1,
    ) -> None:
        super().__init__()
        self.conv = nn.Conv2d(cin, cout, kernel_size, stride, padding, groups=groups, bias=False)
        self.bn = nn.BatchNorm2d(cout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.bn(self.conv(x))


class DepthWiseSeparableConv(nn.Module):
    """Expand, depthwise, project, then ECA; `groups` is the expanded width (upstream name)."""

    def __init__(
        self, cin: int, cout: int, stride=(2, 2), groups: int = 1, residual: bool = False
    ) -> None:
        super().__init__()
        self.residual = residual
        self.conv_expand = ConvBlock(cin, groups)
        self.conv_dw = ConvBlock(groups, groups, (3, 3), stride, (1, 1), groups=groups)
        self.conv_project = LinearBlock(groups, cout)
        self.eca = ECAModule(cout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.eca(self.conv_project(self.conv_dw(self.conv_expand(x))))
        return y + x if self.residual else y


class ResidualBlock(nn.Module):
    def __init__(self, channels: int, num_blocks: int, groups: int) -> None:
        super().__init__()
        self.layers = nn.Sequential(
            *[
                DepthWiseSeparableConv(channels, channels, (1, 1), groups, residual=True)
                for _ in range(num_blocks)
            ]
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.layers(x)


class GDC(nn.Module):
    """Global depthwise convolution over the 7x7 map, then the embedding and its BN."""

    def __init__(self, num_features: int = 512) -> None:
        super().__init__()
        self.conv_dw = LinearBlock(512, 512, (FINAL_MAP, FINAL_MAP), groups=512)
        self.flatten = nn.Flatten()
        self.fc = nn.Linear(512, num_features, bias=False)
        self.bn = nn.BatchNorm1d(num_features)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.bn(self.fc(self.flatten(self.conv_dw(x))))


@MODELS.register("mobilefacenet_eca")
class MobileFaceNetECA(nn.Module):
    """112x112 aligned face to a 512-D embedding; FRBench's `output_name: GDC` layout."""

    def __init__(self, num_features: int = 512, input_size: int = INPUT_SIZE) -> None:
        super().__init__()
        if input_size != INPUT_SIZE:
            raise ValueError(
                f"the published weights close on a {FINAL_MAP}x{FINAL_MAP} kernel, "
                f"which only a {INPUT_SIZE} input leaves"
            )
        self.conv1 = ConvBlock(3, 64, (3, 3), (2, 2), (1, 1))
        self.conv2_dw = ConvBlock(64, 64, (3, 3), (1, 1), (1, 1), groups=64)
        self.conv_23 = DepthWiseSeparableConv(64, 64, (2, 2), groups=128)
        self.conv_3 = ResidualBlock(64, num_blocks=4, groups=128)
        self.conv_34 = DepthWiseSeparableConv(64, 128, (2, 2), groups=256)
        self.conv_4 = ResidualBlock(128, num_blocks=6, groups=256)
        self.conv_45 = DepthWiseSeparableConv(128, 128, (2, 2), groups=512)
        self.conv_5 = ResidualBlock(128, num_blocks=2, groups=256)
        self.conv_6_sep = ConvBlock(128, 512)
        self.output_layer = GDC(num_features)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.conv2_dw(self.conv1(x))
        x = self.conv_3(self.conv_23(x))
        x = self.conv_4(self.conv_34(x))
        x = self.conv_5(self.conv_45(x))
        return self.output_layer(self.conv_6_sep(x))
