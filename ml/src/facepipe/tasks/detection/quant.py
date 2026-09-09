"""Calibration set for the detection branch (KEHOACH 3.7).

The converter measures activation ranges on whatever it is fed, so the crops
here come through the same letterbox the training split uses. Ranges taken
from noise cost more accuracy than the quantisation itself.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch


def calibration_batches(cfg: object, split: str | None, limit: int):
    """Yield real images one at a time, keyed by the graph's input name."""
    from .data import WiderFaceDataset, collate

    dataset = WiderFaceDataset(
        coco=Path(cfg.data.params["coco"]),
        images_root=Path(cfg.data.params["images"]),
        split_file=Path(split or cfg.data.split_files[1]),
        input_hw=tuple(cfg.model.input_hw),
        train=False,
        seed=cfg.run.seed,
    )
    loader = torch.utils.data.DataLoader(dataset, batch_size=1, collate_fn=collate)
    for taken, batch in enumerate(loader):
        if taken >= limit:
            return
        images = batch[0].numpy().transpose(0, 2, 3, 1)
        yield {"image": np.ascontiguousarray(images, dtype=np.float32)}


def torch_batches(cfg: object, split: str | None, samples: int):
    """One batch shaped the way the model's own forward reads it."""
    from .data import WiderFaceDataset, collate

    dataset = WiderFaceDataset(
        coco=Path(cfg.data.params["coco"]),
        images_root=Path(cfg.data.params["images"]),
        split_file=Path(split or cfg.data.split_files[1]),
        input_hw=tuple(cfg.model.input_hw),
        train=False,
        seed=cfg.run.seed,
    )
    loader = torch.utils.data.DataLoader(dataset, batch_size=samples, collate_fn=collate)
    for batch in loader:
        yield batch[0]
        return
