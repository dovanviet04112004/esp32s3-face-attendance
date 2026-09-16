"""MiniFASNetV2 as Silent-Face-Anti-Spoofing builds it, for weights imported whole.

Attribute names follow the upstream module so its state dict loads as it is
(KEHOACH 3). The activation is the one departure: a flag, because PReLU has no
esp-nn kernel and the imported slopes are small enough for ReLU to stand in.
"""

from __future__ import annotations

import torch
from torch import nn

from facepipe.core.registry import MODELS

# keep_dict['1.8M_'] upstream: every channel count the blocks are wired with.
KEEP = (32, 32, 103, 103, 64, 13, 13, 64, 13, 13, 64, 13, 13, 64, 13, 13, 64, 231, 231, 128,
        231, 231, 128, 52, 52, 128, 26, 26, 128, 77, 77, 128, 26, 26, 128, 26, 26, 128, 308,
        308, 128, 26, 26, 128, 26, 26, 128, 512, 512)
# Four stride-2 stages, so the closing depthwise kernel is the map they leave.
DOWNSAMPLES = 4
FLAT_FEATURES = 512


def activation_for(name: str, channels: int) -> nn.Module:
    if name == "prelu":
        return nn.PReLU(channels)
    if name == "relu":
        return nn.ReLU(inplace=True)
    raise ValueError(f"activation must be 'prelu' or 'relu', got {name!r}")


class ConvBlock(nn.Module):
    """Convolution, batch norm, activation, in the upstream field names."""

    def __init__(self, in_c: int, out_c: int, kernel=(1, 1), stride=(1, 1), padding=(0, 0),
                 groups: int = 1, activation: str = "relu") -> None:
        super().__init__()
        self.conv = nn.Conv2d(in_c, out_c, kernel, stride=stride, padding=padding,
                              groups=groups, bias=False)
        self.bn = nn.BatchNorm2d(out_c)
        self.act = activation_for(activation, out_c)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.act(self.bn(self.conv(x)))


class LinearBlock(nn.Module):
    """Convolution and batch norm with no activation, for the projections."""

    def __init__(self, in_c: int, out_c: int, kernel=(1, 1), stride=(1, 1), padding=(0, 0),
                 groups: int = 1) -> None:
        super().__init__()
        self.conv = nn.Conv2d(in_c, out_c, kernel, stride=stride, padding=padding,
                              groups=groups, bias=False)
        self.bn = nn.BatchNorm2d(out_c)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.bn(self.conv(x))


class DepthWise(nn.Module):
    """Pointwise expand, depthwise, pointwise project, with an optional skip."""

    def __init__(self, c1, c2, c3, residual: bool = False, kernel=(3, 3), stride=(2, 2),
                 padding=(1, 1), groups: int = 1, activation: str = "relu") -> None:
        super().__init__()
        self.conv = ConvBlock(c1[0], c1[1], activation=activation)
        self.conv_dw = ConvBlock(c2[0], c2[1], kernel, stride, padding, groups=c2[0],
                                 activation=activation)
        self.project = LinearBlock(c3[0], c3[1])
        self.residual = residual

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = self.project(self.conv_dw(self.conv(x)))
        return x + out if self.residual else out


class Residual(nn.Module):
    """A run of skip-connected DepthWise blocks, held under `model` as upstream does."""

    def __init__(self, c1, c2, c3, num_block: int, groups: int, activation: str) -> None:
        super().__init__()
        self.model = nn.Sequential(*[
            DepthWise(c1[i], c2[i], c3[i], residual=True, stride=(1, 1), groups=groups,
                      activation=activation)
            for i in range(num_block)
        ])

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.model(x)


class SplitPReLUStem(nn.Module):
    """conv1's PReLU as two ReLU branches, so the graph carries no PRELU op (KEHOACH 3).

    PReLU(t) = ReLU(t) - a * ReLU(-t), and the depthwise conv that follows is
    linear per channel, so the a-scaled branch folds into a second depthwise.
    """

    def __init__(self, out_c: int, dw_c: int, activation: str) -> None:
        super().__init__()
        self.conv_pos = ConvBlock(3, out_c, (3, 3), (2, 2), (1, 1), activation="relu")
        self.conv_neg = ConvBlock(3, out_c, (3, 3), (2, 2), (1, 1), activation="relu")
        self.dw_pos = ConvBlock(out_c, dw_c, (3, 3), (1, 1), (1, 1), groups=dw_c,
                                activation=activation)
        self.dw_neg = nn.Conv2d(out_c, dw_c, (3, 3), stride=(1, 1), padding=(1, 1), groups=dw_c,
                                bias=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        pos = self.dw_pos.bn(self.dw_pos.conv(self.conv_pos(x)))
        return self.dw_pos.act(pos + self.dw_neg(self.conv_neg(x)))


@MODELS.register("minifasnet_v2")
class MiniFASNetV2(nn.Module):
    """The upstream classifier over one face crop, three classes out.

    forward takes the (tight, wide) tuple the trainer hands every model and reads
    the view named by `view`; a bare tensor, as export traces it, is read as is.
    """

    def __init__(
        self,
        num_classes: int = 3,
        embedding: int = 128,
        activation: str = "relu",
        input_size: int = 80,
        view: str = "wide",
        chroma: bool = False,
        stem: str = "plain",
        drop_p: float = 0.2,
    ) -> None:
        super().__init__()
        if view not in ("tight", "wide"):
            raise ValueError(f"view must be 'tight' or 'wide', got {view!r}")
        if stem not in ("plain", "split_prelu"):
            raise ValueError(f"stem must be 'plain' or 'split_prelu', got {stem!r}")
        if chroma:
            raise ValueError("the imported weights read three planes; chroma must stay off")
        self.chroma = False
        if input_size % (2 ** DOWNSAMPLES) != 0:
            raise ValueError(f"input_size must be a multiple of {2 ** DOWNSAMPLES}, got {input_size}")
        self.view = view
        self.embedding_size = embedding
        k, act = KEEP, activation
        closing = input_size // (2 ** DOWNSAMPLES)

        if stem == "split_prelu":
            self.stem = SplitPReLUStem(k[0], k[1], act)
        else:
            self.conv1 = ConvBlock(3, k[0], (3, 3), (2, 2), (1, 1), activation=act)
            self.conv2_dw = ConvBlock(k[0], k[1], (3, 3), (1, 1), (1, 1), groups=k[1],
                                      activation=act)
        self.conv_23 = DepthWise((k[1], k[2]), (k[2], k[3]), (k[3], k[4]), groups=k[3],
                                 activation=act)
        self.conv_3 = Residual(
            [(k[4], k[5]), (k[7], k[8]), (k[10], k[11]), (k[13], k[14])],
            [(k[5], k[6]), (k[8], k[9]), (k[11], k[12]), (k[14], k[15])],
            [(k[6], k[7]), (k[9], k[10]), (k[12], k[13]), (k[15], k[16])],
            num_block=4, groups=k[4], activation=act)
        self.conv_34 = DepthWise((k[16], k[17]), (k[17], k[18]), (k[18], k[19]), groups=k[19],
                                 activation=act)
        self.conv_4 = Residual(
            [(k[19], k[20]), (k[22], k[23]), (k[25], k[26]), (k[28], k[29]), (k[31], k[32]),
             (k[34], k[35])],
            [(k[20], k[21]), (k[23], k[24]), (k[26], k[27]), (k[29], k[30]), (k[32], k[33]),
             (k[35], k[36])],
            [(k[21], k[22]), (k[24], k[25]), (k[27], k[28]), (k[30], k[31]), (k[33], k[34]),
             (k[36], k[37])],
            num_block=6, groups=k[19], activation=act)
        self.conv_45 = DepthWise((k[37], k[38]), (k[38], k[39]), (k[39], k[40]), groups=k[40],
                                 activation=act)
        self.conv_5 = Residual(
            [(k[40], k[41]), (k[43], k[44])],
            [(k[41], k[42]), (k[44], k[45])],
            [(k[42], k[43]), (k[45], k[46])],
            num_block=2, groups=k[40], activation=act)
        self.conv_6_sep = ConvBlock(k[46], k[47], activation=act)
        self.conv_6_dw = LinearBlock(k[47], k[48], (closing, closing), groups=k[48])
        self.linear = nn.Linear(FLAT_FEATURES, embedding, bias=False)
        self.bn = nn.BatchNorm1d(embedding)
        self.drop = nn.Dropout(p=drop_p)
        self.prob = nn.Linear(embedding, num_classes, bias=False)

    def forward(self, views: torch.Tensor | tuple[torch.Tensor, ...]) -> torch.Tensor:
        if isinstance(views, (tuple, list)):
            x = views[1] if self.view == "wide" else views[0]
        else:
            x = views
        x = self.stem(x) if hasattr(self, "stem") else self.conv2_dw(self.conv1(x))
        x = self.conv_3(self.conv_23(x))
        x = self.conv_4(self.conv_34(x))
        x = self.conv_5(self.conv_45(x))
        x = self.conv_6_dw(self.conv_6_sep(x))
        x = torch.flatten(x, 1)
        if self.embedding_size != FLAT_FEATURES:
            x = self.linear(x)
        return self.prob(self.drop(self.bn(x)))
