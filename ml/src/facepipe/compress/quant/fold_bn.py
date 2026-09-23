"""Fold every BatchNorm into the convolution or linear layer in front of it.

Equalisation and bias correction both read a layer's weight range, and a range
measured while BatchNorm still holds a separate scale is not the range the
quantiser will see (KEHOACH 3.7).
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


def linear_pairs(model: nn.Module) -> list[tuple[str, str]]:
    """Names of every linear layer immediately followed by a 1-D batch norm, in run order."""
    ordered = list(model.named_modules())
    return [(name, ordered[i + 1][0]) for i, (name, module) in enumerate(ordered[:-1])
            if isinstance(module, nn.Linear) and isinstance(ordered[i + 1][1], nn.BatchNorm1d)]


def fold_linear(model: nn.Module) -> int:
    """Fold each Linear + BatchNorm1d into the Linear and remove the norm; returns the count.

    The norm is replaced, not reset to identity: ESP-PPQ stops at any BatchNorm
    over a 2-D tensor. That changes the state dict, so fold a copy meant for export.
    """
    lookup = dict(model.named_modules())
    done = 0
    for linear_name, bn_name in linear_pairs(model):
        linear, bn = lookup[linear_name], lookup[bn_name]
        scale = 1.0 / torch.sqrt(bn.running_var + bn.eps)
        shift = -bn.running_mean * scale
        if bn.affine:
            shift = shift * bn.weight + bn.bias
            scale = scale * bn.weight
        bias = linear.bias if linear.bias is not None else torch.zeros_like(bn.running_mean)
        with torch.no_grad():
            linear.weight.mul_(scale.reshape(-1, 1))
            linear.bias = nn.Parameter(bias * scale + shift)
        parent_name, _, attr = bn_name.rpartition(".")
        setattr(lookup[parent_name] if parent_name else model, attr, nn.Identity())
        done += 1
    return done
