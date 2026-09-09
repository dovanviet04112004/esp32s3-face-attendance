"""Prior points, one per feature-map cell.

YuNet is anchor-free: a prior is the top-left corner of a cell plus the stride
that cell covers, and the head regresses an offset from it. Nothing here may
drift from ai_engine/src/detection/decode.cpp, which recomputes the same grid on
the device; contracts/golden/detection/decode/ is what holds the two together.
"""

from __future__ import annotations

import torch

PRIOR_COLUMNS = 4


def level_priors(
    feat_h: int, feat_w: int, stride: int, dtype: torch.dtype = torch.float32
) -> torch.Tensor:
    """Grid priors of one level as rows of (x, y, stride_w, stride_h).

    Row order is row-major over the feature map, matching how the head's output
    is flattened; reading it in a different order silently pairs a prediction
    with the wrong cell.
    """
    xs = torch.arange(feat_w, dtype=dtype) * stride
    ys = torch.arange(feat_h, dtype=dtype) * stride
    grid_y, grid_x = torch.meshgrid(ys, xs, indexing="ij")
    flat_x = grid_x.reshape(-1)
    flat_y = grid_y.reshape(-1)
    strides = torch.full_like(flat_x, float(stride))
    return torch.stack([flat_x, flat_y, strides, strides], dim=-1)


def pyramid_priors(
    feat_sizes: list[tuple[int, int]], strides: tuple[int, ...], dtype: torch.dtype = torch.float32
) -> list[torch.Tensor]:
    """One prior tensor per level, in the order the head emits them."""
    if len(feat_sizes) != len(strides):
        raise ValueError(f"{len(feat_sizes)} feature map(s) but {len(strides)} stride(s)")
    return [
        level_priors(h, w, stride, dtype)
        for (h, w), stride in zip(feat_sizes, strides, strict=True)
    ]


def feature_sizes(input_hw: tuple[int, int], strides: tuple[int, ...]) -> list[tuple[int, int]]:
    """Feature-map sizes the backbone produces for a given input.

    Every reduction floors, so a dimension that is not a multiple of the largest
    stride leaves a strip at the right and bottom edges uncovered by the coarse
    levels.
    """
    height, width = input_hw
    sizes = []
    for stride in strides:
        sizes.append((height // stride, width // stride))
    return sizes
