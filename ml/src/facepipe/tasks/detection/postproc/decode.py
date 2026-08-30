"""Turning raw head output into pixel coordinates.

Must stay identical to ai_engine/src/detection/decode.cpp. The training losses
decode through these same functions rather than their own copy: a second
implementation is a second thing to keep in step, and the drift shows up as a
model that scores well in Python and misses faces on the board.

Box encoding is YOLOX-style. The head predicts a centre offset in units of the
prior's stride and a log-scale for the size; landmarks are plain offsets in the
same units.
"""

from __future__ import annotations

import torch

from ..student.head import HeadOutput


def flatten_levels(tensors: list[torch.Tensor]) -> torch.Tensor:
    """Concatenate per-level (B, C, H, W) maps into one (B, sum(H*W), C).

    Row-major within a level and levels in head order, which is the order
    pyramid_priors emits; any other order pairs a prediction with a prior that
    belongs to a different cell.
    """
    flat = [t.permute(0, 2, 3, 1).reshape(t.shape[0], -1, t.shape[1]) for t in tensors]
    return torch.cat(flat, dim=1)


def flatten_output(out: HeadOutput) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """Flatten the three branches together, keeping them aligned."""
    return flatten_levels(out.cls), flatten_levels(out.bbox), flatten_levels(out.kps)


def bbox_decode(priors: torch.Tensor, deltas: torch.Tensor) -> torch.Tensor:
    """Centre offset and log-scale to xyxy pixels."""
    centres = deltas[..., :2] * priors[..., 2:] + priors[..., :2]
    sizes = deltas[..., 2:].exp() * priors[..., 2:]
    half = sizes / 2
    return torch.cat([centres - half, centres + half], dim=-1)


def bbox_encode(priors: torch.Tensor, boxes: torch.Tensor, eps: float = 1e-6) -> torch.Tensor:
    """Inverse of bbox_decode, for turning labels into regression targets."""
    centres = (boxes[..., :2] + boxes[..., 2:]) / 2
    sizes = (boxes[..., 2:] - boxes[..., :2]).clamp_min(eps)
    return torch.cat(
        [
            (centres - priors[..., :2]) / priors[..., 2:],
            (sizes / priors[..., 2:]).log(),
        ],
        dim=-1,
    )


def kps_decode(priors: torch.Tensor, deltas: torch.Tensor) -> torch.Tensor:
    """Landmark offsets to pixels, interleaved x, y."""
    offsets = deltas.reshape(*deltas.shape[:-1], -1, 2)
    points = offsets * priors[..., None, 2:] + priors[..., None, :2]
    return points.reshape(*deltas.shape)


def kps_encode(priors: torch.Tensor, points: torch.Tensor) -> torch.Tensor:
    """Inverse of kps_decode."""
    pixels = points.reshape(*points.shape[:-1], -1, 2)
    offsets = (pixels - priors[..., None, :2]) / priors[..., None, 2:]
    return offsets.reshape(*points.shape)
