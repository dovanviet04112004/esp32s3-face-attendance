"""Calibration set for the anti-spoof branch (KEHOACH 3.8).

Both crops of a pair have to arrive together: the graph reads them as two
inputs, and calibrating one while the other holds zeros measures a range the
model never meets. Section 1 of the quant ladder asks for OV5640 frames here.
"""

from __future__ import annotations

import numpy as np


def calibration_batches(cfg: object, split: str | None, limit: int):
    """Yield real crop pairs one at a time, keyed by the graph's input names."""
    from .eval import build_loader

    loader = build_loader(cfg, split or cfg.data.params["val_split"])
    taken = 0
    for tight, wide, _labels, _scale in loader:
        for i in range(tight.shape[0]):
            if taken >= limit:
                return
            yield {
                "tight": np.ascontiguousarray(
                    tight[i : i + 1].numpy().transpose(0, 2, 3, 1), dtype=np.float32
                ),
                "wide": np.ascontiguousarray(
                    wide[i : i + 1].numpy().transpose(0, 2, 3, 1), dtype=np.float32
                ),
            }
            taken += 1


def torch_batches(cfg: object, split: str | None, samples: int):
    """One batch shaped the way the student's own forward reads it: a pair."""
    from .eval import build_loader

    split = split or cfg.data.params["val_split"]
    for tight, wide, _labels, _scale in build_loader(cfg, split):
        yield (tight[:samples], wide[:samples])
        return
