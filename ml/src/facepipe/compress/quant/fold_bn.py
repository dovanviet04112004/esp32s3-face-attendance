"""Fold every BatchNorm into the convolution in front of it.

Equalisation and bias correction both read a layer's weight range, and a range
measured while BatchNorm still holds a separate scale is not the range the
quantiser will see (KEHOACH 3.8).
"""

import torch
from torch import nn

FOLDABLE = (nn.Conv2d, nn.ConvTranspose2d)


def folded_weight(conv: nn.Conv2d, bn: nn.BatchNorm2d) -> tuple[torch.Tensor, torch.Tensor]:
    """The weight and bias the pair collapses to, in the convolution's layout."""
    scale = bn.weight / torch.sqrt(bn.running_var + bn.eps)
    weight = conv.weight * scale.reshape(-1, 1, 1, 1)
    bias = conv.bias if conv.bias is not None else torch.zeros_like(bn.running_mean)
    return weight, (bias - bn.running_mean) * scale + bn.bias


def pairs(model: nn.Module) -> list[tuple[str, str]]:
    """Names of every conv immediately followed by a batch norm, in run order."""
    ordered = list(model.named_modules())
    found: list[tuple[str, str]] = []
    for i, (name, module) in enumerate(ordered[:-1]):
        follower_name, follower = ordered[i + 1]
        if isinstance(module, FOLDABLE) and isinstance(follower, nn.BatchNorm2d):
            found.append((name, follower_name))
    return found


def fold(model: nn.Module) -> int:
    """Rewrite the model in place and return how many pairs collapsed."""
    lookup = dict(model.named_modules())
    done = 0
    for conv_name, bn_name in pairs(model):
        conv, bn = lookup[conv_name], lookup[bn_name]
        weight, bias = folded_weight(conv, bn)
        with torch.no_grad():
            conv.weight.copy_(weight)
            if conv.bias is None:
                conv.bias = nn.Parameter(bias)
            else:
                conv.bias.copy_(bias)
        # The norm stays in the graph as an identity: dropping the module would
        # break every state dict and every hook that names it.
        bn.reset_parameters()
        with torch.no_grad():
            bn.weight.fill_(1.0)
            bn.bias.zero_()
            bn.running_mean.zero_()
            bn.running_var.fill_(1.0 - bn.eps)
        done += 1
    return done
