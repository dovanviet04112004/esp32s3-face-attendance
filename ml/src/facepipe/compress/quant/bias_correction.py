"""Push the mean error quantisation leaves in a layer back into its bias.

Rounding weights does not shift a layer's output symmetrically: over a real
batch the error has a mean, and that mean travels through every layer after
it. Measuring it and subtracting it costs one pass and no labels (KEHOACH 3.8).
"""

from collections.abc import Iterable

import torch
from torch import nn


def fake_quantize(weight: torch.Tensor, bits: int = 8) -> torch.Tensor:
    """The weight as the per-channel integer quantiser would round it."""
    levels = 2 ** (bits - 1) - 1
    flat = weight.reshape(weight.shape[0], -1)
    scale = flat.abs().amax(dim=1).clamp(min=1e-12) / levels
    shaped = scale.reshape(-1, *([1] * (weight.dim() - 1)))
    return torch.round(weight / shaped).clamp(-levels - 1, levels) * shaped


def layer_shift(conv: nn.Conv2d, samples: torch.Tensor) -> torch.Tensor:
    """Mean per-channel gap between the float layer and its quantised copy."""
    with torch.no_grad():
        exact = nn.functional.conv2d(
            samples, conv.weight, None, conv.stride, conv.padding, conv.dilation, conv.groups
        )
        rounded = nn.functional.conv2d(
            samples,
            fake_quantize(conv.weight),
            None,
            conv.stride,
            conv.padding,
            conv.dilation,
            conv.groups,
        )
    return (exact - rounded).mean(dim=(0, 2, 3))


def correct(model: nn.Module, feed: Iterable[tuple[torch.Tensor, torch.Tensor]]) -> dict[str, float]:
    """Adjust every convolution's bias by the shift its own inputs reveal."""
    seen: dict[str, torch.Tensor] = {}
    handles = []

    def remember(name: str):
        def hook(_module, inputs, _output):
            if name not in seen:
                seen[name] = inputs[0].detach()

        return hook

    for name, module in model.named_modules():
        if isinstance(module, nn.Conv2d):
            handles.append(module.register_forward_hook(remember(name)))
    with torch.no_grad():
        for views in feed:
            model(views)
            break
    for handle in handles:
        handle.remove()

    moved: dict[str, float] = {}
    lookup = dict(model.named_modules())
    for name, samples in seen.items():
        conv = lookup[name]
        shift = layer_shift(conv, samples)
        if conv.bias is None:
            conv.bias = nn.Parameter(torch.zeros(conv.out_channels))
        with torch.no_grad():
            conv.bias.add_(shift)
        moved[name] = float(shift.abs().max())
    return moved
