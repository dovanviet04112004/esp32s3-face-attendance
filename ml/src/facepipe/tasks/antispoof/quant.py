"""Calibration set for the anti-spoof branch (KEHOACH 3.7).

Every input the graph has arrives in the same sample: calibrating one while
another holds zeros measures a range the model never meets. Section 1 of the
quant ladder asks for OV5640 frames here.
"""

from __future__ import annotations

import numpy as np


def calibration_batches(cfg: object, split: str | None, limit: int):
    """Yield real crops one sample at a time, keyed by the graph's input names."""
    from .eval import build_loader, input_names

    names = input_names(cfg)
    loader = build_loader(cfg, split or cfg.data.params["val_split"])
    taken = 0
    for tight, wide, _labels, _scale in loader:
        views = {"tight": tight, "wide": wide}
        for i in range(tight.shape[0]):
            if taken >= limit:
                return
            yield {
                name: np.ascontiguousarray(
                    views[name][i : i + 1].numpy().transpose(0, 2, 3, 1), dtype=np.float32
                )
                for name in names
            }
            taken += 1


def torch_batches(cfg: object, split: str | None, samples: int):
    """One batch shaped the way the model's own forward reads it."""
    from .eval import build_loader, input_names

    split = split or cfg.data.params["val_split"]
    for tight, wide, _labels, _scale in build_loader(cfg, split):
        if len(input_names(cfg)) > 1:
            yield (tight[:samples], wide[:samples])
        else:
            yield tight[:samples]
        return
