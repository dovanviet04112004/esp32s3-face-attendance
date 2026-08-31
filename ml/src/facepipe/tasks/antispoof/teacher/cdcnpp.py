"""CDCN++: the anti-spoof teacher, supervised on depth rather than a class.

Its one idea is the central difference convolution. A normal convolution sums
weighted intensities, which a printed photograph reproduces faithfully; this one
subtracts the centre pixel from each neighbour first, so what it sees is local
gradient. Print and screen leave gradient signatures that intensity alone hides,
and theta sets how much of that difference is mixed into the ordinary response.

MAFM is the second piece: three depths of the backbone are pooled to one size and
gated by attention before being fused, so the head reads fine texture and coarse
geometry together instead of only the last layer's view.

The output is a depth map, not a logit. Turning it into a score is the caller's
job, and export_soft_target does it the same way for every arm.
"""

from __future__ import annotations

import torch
from torch import nn
from torch.nn import functional as fn

from facepipe.core.registry import TEACHERS

from .depth_gt import DEPTH_SIZE


class CDConv2d(nn.Module):
    """Convolution mixed with its own central difference, by theta.

    theta = 0 is an ordinary convolution and theta = 1 uses gradient alone. The
    difference term reuses the same weights, so it costs one extra sum over the
    kernel rather than a second set of parameters.
    """

    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        kernel_size: int = 3,
        stride: int = 1,
        padding: int = 1,
        theta: float = 0.7,
    ) -> None:
        super().__init__()
        self.conv = nn.Conv2d(in_channels, out_channels, kernel_size, stride, padding, bias=False)
        self.theta = theta

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = self.conv(x)
        if self.theta == 0.0:
            return out
        # Summing the kernel collapses it to the single weight a constant input
        # sees, which is exactly what the difference term has to subtract.
        centre = self.conv.weight.sum(dim=(2, 3), keepdim=True)
        difference = fn.conv2d(x, centre, stride=self.conv.stride, padding=0)
        return out - self.theta * difference


class CDCBlock(nn.Module):
    """Central difference convolution, batch norm, ReLU."""

    def __init__(
        self, in_channels: int, out_channels: int, stride: int = 1, theta: float = 0.7
    ) -> None:
        super().__init__()
        self.conv = CDConv2d(in_channels, out_channels, 3, stride, 1, theta)
        self.bn = nn.BatchNorm2d(out_channels)
        self.act = nn.ReLU(inplace=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.act(self.bn(self.conv(x)))


class SpatialAttention(nn.Module):
    """One gate per pixel, from the channel mean and max at that pixel."""

    def __init__(self, kernel_size: int = 7) -> None:
        super().__init__()
        self.conv = nn.Conv2d(2, 1, kernel_size, padding=kernel_size // 2, bias=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        pooled = torch.cat((x.mean(dim=1, keepdim=True), x.amax(dim=1, keepdim=True)), dim=1)
        return x * torch.sigmoid(self.conv(pooled))


class MAFM(nn.Module):
    """Multiscale attention fusion: pool three depths to one size, gate, concat."""

    def __init__(self, channels: tuple[int, int, int], size: int = DEPTH_SIZE) -> None:
        super().__init__()
        self.size = size
        self.gates = nn.ModuleList(SpatialAttention() for _ in channels)

    def forward(self, features: tuple[torch.Tensor, ...]) -> torch.Tensor:
        resized = [
            gate(fn.adaptive_avg_pool2d(feature, self.size))
            for gate, feature in zip(self.gates, features, strict=True)
        ]
        return torch.cat(resized, dim=1)


@TEACHERS.register("cdcnpp")
class CDCNpp(nn.Module):
    """Three stages of central difference convolutions fused into a depth map."""

    def __init__(self, theta: float = 0.7, depth_size: int = DEPTH_SIZE, width: int = 64) -> None:
        super().__init__()
        self.stem = CDCBlock(3, width, theta=theta)
        self.stage_1 = nn.Sequential(
            CDCBlock(width, width * 2, theta=theta),
            CDCBlock(width * 2, width, theta=theta),
            nn.MaxPool2d(2),
        )
        self.stage_2 = nn.Sequential(
            CDCBlock(width, width * 2, theta=theta),
            CDCBlock(width * 2, width, theta=theta),
            nn.MaxPool2d(2),
        )
        self.stage_3 = nn.Sequential(
            CDCBlock(width, width * 2, theta=theta),
            CDCBlock(width * 2, width, theta=theta),
            nn.MaxPool2d(2),
        )
        self.fuse = MAFM((width, width, width), depth_size)
        self.head = nn.Sequential(
            CDCBlock(width * 3, width, theta=theta),
            CDCBlock(width, width // 2, theta=theta),
            nn.Conv2d(width // 2, 1, kernel_size=3, padding=1, bias=False),
            nn.ReLU(inplace=True),
        )

    def forward(self, views: tuple[torch.Tensor, torch.Tensor] | torch.Tensor) -> torch.Tensor:
        # The student reads two crops; the teacher reads the wide one, which is
        # where the flat-surface evidence lives.
        x = views[1] if isinstance(views, tuple | list) else views
        x = self.stem(x)
        first = self.stage_1(x)
        second = self.stage_2(first)
        third = self.stage_3(second)
        return self.head(self.fuse((first, second, third))).squeeze(1)


def depth_to_score(depth: torch.Tensor) -> torch.Tensor:
    """Mean activation of the map, the scalar a depth model is scored on.

    A flat map means an attack, so a low mean is a low liveness score. Thresholds
    live with the caller; this only collapses the map the same way every time.
    """
    return depth.flatten(1).mean(dim=1)
