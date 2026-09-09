"""Building blocks of the MiniFASNet model.

Every spatial convolution is depthwise so ESP-NN can accelerate it, and the
squeeze-excite gate uses HardSigmoid: ReLU6(x + 3) / 6 is piecewise linear, so
INT8 reproduces it exactly where a sigmoid needs a lookup table (KEHOACH 3).
"""

from __future__ import annotations

import torch
from torch import nn

# What esp-nn can express as a clamp on the convolution it already ran. relu
# keeps the positive homogeneity cross-layer equalisation needs (KEHOACH 3.7).
ACTIVATIONS = {"relu6": nn.ReLU6, "relu": nn.ReLU}


def build_activation(name: str) -> nn.Module:
    """The activation a branch config asks for, refusing anything unfoldable."""
    if name not in ACTIVATIONS:
        raise ValueError(f"{name}: activation must be one of {sorted(ACTIVATIONS)}")
    return ACTIVATIONS[name](inplace=True)


class ConvBnAct(nn.Module):
    """Convolution, batch norm, activation: the unit the backbone is built from."""

    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        kernel_size: int | tuple[int, int] = 1,
        stride: int = 1,
        padding: int | tuple[int, int] = 0,
        groups: int = 1,
        activation: str = "relu6",
    ) -> None:
        super().__init__()
        self.conv = nn.Conv2d(
            in_channels, out_channels, kernel_size, stride, padding, groups=groups, bias=False
        )
        self.bn = nn.BatchNorm2d(out_channels)
        self.act = build_activation(activation)

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


class HardSigmoid(nn.Module):
    """ReLU6(x + 3) / 6, the piecewise-linear stand-in for a sigmoid gate."""

    def __init__(self) -> None:
        super().__init__()
        self.relu6 = nn.ReLU6(inplace=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.relu6(x + 3.0) / 6.0


class SqueezeExcite(nn.Module):
    """Channel gate: pool to one value per channel, then scale the map by it.

    map_size is written out rather than adapted because a fixed window exports
    as AVERAGE_POOL_2D, which esp-nn accelerates, while an adaptive one becomes
    MEAN, which it does not (KEHOACH 3 layer 1).
    """

    def __init__(self, channels: int, map_size: int, reduction: int = 8) -> None:
        super().__init__()
        hidden = max(channels // reduction, 1)
        self.pool = nn.AvgPool2d(map_size)
        self.down = nn.Conv2d(channels, hidden, kernel_size=1, bias=True)
        self.act = nn.ReLU6(inplace=True)
        self.up = nn.Conv2d(hidden, channels, kernel_size=1, bias=True)
        self.gate = HardSigmoid()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        weights = self.gate(self.up(self.act(self.down(self.pool(x)))))
        return x * weights


class DepthWise(nn.Module):
    """Expand pointwise, filter depthwise, project back, with an optional gate."""

    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        expand: int,
        out_map: int,
        kernel_size: int = 3,
        stride: int = 1,
        padding: int = 1,
        squeeze_excite: bool = True,
        activation: str = "relu6",
    ) -> None:
        super().__init__()
        self.expand = ConvBnAct(in_channels, expand, kernel_size=1, activation=activation)
        self.filter = ConvBnAct(
            expand, expand, kernel_size, stride, padding, groups=expand, activation=activation
        )
        self.excite = SqueezeExcite(expand, out_map) if squeeze_excite else None
        self.project = ConvBn(expand, out_channels, kernel_size=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.filter(self.expand(x))
        if self.excite is not None:
            x = self.excite(x)
        return self.project(x)


class Residual(nn.Module):
    """A stack of DepthWise blocks, each added back to its own input."""

    def __init__(
        self,
        channels: int,
        blocks: int,
        expand: int,
        map_size: int,
        kernel_size: int = 3,
        padding: int = 1,
        squeeze_excite: bool = True,
        activation: str = "relu6",
    ) -> None:
        super().__init__()
        self.blocks = nn.ModuleList(
            DepthWise(
                channels,
                channels,
                expand,
                map_size,
                kernel_size,
                stride=1,
                padding=padding,
                squeeze_excite=squeeze_excite,
                activation=activation,
            )
            for _ in range(blocks)
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        for block in self.blocks:
            x = x + block(x)
        return x
