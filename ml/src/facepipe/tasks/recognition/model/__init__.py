"""Recognition architectures. Importing this registers "mobilefacenet" and "mobilefacenet_eca"."""

from .blocks import ConvBn, ConvBnAct, DepthWise, Residual
from .mobilefacenet import FINAL_MAP, INPUT_SIZE, MobileFaceNet
from .mobilefacenet_eca import MobileFaceNetECA

__all__ = [
    "FINAL_MAP",
    "INPUT_SIZE",
    "ConvBn",
    "ConvBnAct",
    "DepthWise",
    "MobileFaceNet",
    "MobileFaceNetECA",
    "Residual",
]
