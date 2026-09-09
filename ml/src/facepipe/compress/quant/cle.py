"""Cross-layer equalisation: move scale between neighbouring convolutions.

A channel whose weights are far larger than its neighbours' forces the whole
tensor's quantisation range wide, and every other channel loses resolution to
it. Scaling one layer down and the next one up by the same factor leaves the
function unchanged while the ranges even out (KEHOACH 3.7).
"""

import torch
from torch import nn

# Holds only where f(s*x) == s*f(x) for positive s: ReLU and PReLU qualify,
# a clamped ReLU6 does not, since its ceiling stays put while the scale moves.
SCALE_EQUIVARIANT = (nn.ReLU, nn.PReLU, nn.Identity)

EPS = 1e-8


def channel_range(weight: torch.Tensor, axis: int) -> torch.Tensor:
    """Largest absolute weight per channel along one axis."""
    moved = weight.transpose(0, axis).reshape(weight.shape[axis], -1)
    return moved.abs().amax(dim=1)


def is_depthwise(conv: nn.Conv2d) -> bool:
    return conv.groups == conv.in_channels and conv.groups != 1


def equalize(first: nn.Conv2d, second: nn.Conv2d) -> torch.Tensor:
    """Balance one pair in place and return the scale it applied per channel."""
    out_range = channel_range(first.weight, 0)
    in_axis = 0 if is_depthwise(second) else 1
    in_range = channel_range(second.weight, in_axis)

    scale = torch.sqrt(out_range / (in_range + EPS)).clamp(min=EPS)
    # A channel that is dead in either layer has no range to trade, and the
    # square root above would hand it a meaningless factor.
    scale[(out_range < EPS) | (in_range < EPS)] = 1.0

    with torch.no_grad():
        first.weight.div_(scale.reshape(-1, 1, 1, 1))
        if first.bias is not None:
            first.bias.div_(scale)
        if in_axis == 0:
            second.weight.mul_(scale.reshape(-1, 1, 1, 1))
        else:
            second.weight.mul_(scale.reshape(1, -1, 1, 1))
    return scale


def pairs(model: nn.Module) -> list[tuple[str, str]]:
    """Neighbouring convolutions with only scale-equivariant work between them."""
    ordered = [(n, m) for n, m in model.named_modules() if not list(m.children())]
    found: list[tuple[str, str]] = []
    for i, (name, module) in enumerate(ordered):
        if not isinstance(module, nn.Conv2d):
            continue
        for follower_name, follower in ordered[i + 1 :]:
            if isinstance(follower, nn.Conv2d):
                channels = follower.in_channels if not is_depthwise(follower) else follower.groups
                if channels == module.out_channels:
                    found.append((name, follower_name))
                break
            if not isinstance(follower, (*SCALE_EQUIVARIANT, nn.BatchNorm2d)):
                break
    return found


def apply(model: nn.Module) -> dict[str, float]:
    """Equalise every eligible pair and report how far each one moved."""
    lookup = dict(model.named_modules())
    moved: dict[str, float] = {}
    for first_name, second_name in pairs(model):
        scale = equalize(lookup[first_name], lookup[second_name]).detach()
        moved[f"{first_name}->{second_name}"] = float(scale.max() / scale.min())
    return moved
