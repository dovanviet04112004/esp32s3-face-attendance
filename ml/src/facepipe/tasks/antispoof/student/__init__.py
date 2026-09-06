"""MiniFASNet architecture. Importing this registers the model under "minifasnet_v2_se"."""

from .blocks import ConvBn, ConvBnAct, DepthWise, HardSigmoid, Residual, SqueezeExcite
from .minifasnet_v2_se import INPUT_SIZE, MiniFASNetBackbone, MiniFASNetV2SE

__all__ = [
    "INPUT_SIZE",
    "ConvBn",
    "ConvBnAct",
    "DepthWise",
    "HardSigmoid",
    "MiniFASNetBackbone",
    "MiniFASNetV2SE",
    "Residual",
    "SqueezeExcite",
]
