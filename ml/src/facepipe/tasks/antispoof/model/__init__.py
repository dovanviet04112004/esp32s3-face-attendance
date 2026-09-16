"""MiniFASNet architectures. Importing this registers "minifasnet_v2_se" and "minifasnet_v2"."""

from .blocks import ConvBn, ConvBnAct, DepthWise, HardSigmoid, Residual, SqueezeExcite
from .minifasnet_v2 import MiniFASNetV2
from .minifasnet_v2_se import INPUT_SIZE, MiniFASNetBackbone, MiniFASNetV2SE

__all__ = [
    "INPUT_SIZE",
    "ConvBn",
    "ConvBnAct",
    "DepthWise",
    "HardSigmoid",
    "MiniFASNetBackbone",
    "MiniFASNetV2",
    "MiniFASNetV2SE",
    "Residual",
    "SqueezeExcite",
]
