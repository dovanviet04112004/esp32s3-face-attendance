"""MobileFaceNet architecture. Importing this registers the model under "mobilefacenet"."""

from .blocks import ConvBn, ConvBnAct, DepthWise, Residual
from .mobilefacenet import FINAL_MAP, INPUT_SIZE, MobileFaceNet

__all__ = [
    "FINAL_MAP",
    "INPUT_SIZE",
    "ConvBn",
    "ConvBnAct",
    "DepthWise",
    "MobileFaceNet",
    "Residual",
]
