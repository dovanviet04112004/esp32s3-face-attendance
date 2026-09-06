"""Calibration set for the recognition branch (KEHOACH 3.8).

Faces reach the graph already normalised, so the calibration path applies the
same normalisation training applies. Feeding raw bytes here would set every
activation range against a scale the model never sees.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch


def calibration_batches(cfg: object, split: str | None, limit: int):
    """Yield real aligned faces one at a time, keyed by the graph's input name."""
    from .data import Ms1mShardDataset, collate, normalize_batch, read_identities

    dataset = Ms1mShardDataset(
        root=Path(cfg.data.params["shards"]),
        identities=read_identities(Path(split or cfg.data.split_files[1])),
        size=int(cfg.model.input_hw[0]),
        train=False,
        seed=cfg.run.seed,
    )
    loader = torch.utils.data.DataLoader(dataset, batch_size=1, collate_fn=collate)
    for taken, (images, _targets) in enumerate(loader):
        if taken >= limit:
            return
        faces = normalize_batch(images).numpy().transpose(0, 2, 3, 1)
        yield {"face": np.ascontiguousarray(faces, dtype=np.float32)}


def torch_batches(cfg: object, split: str | None, samples: int):
    """One batch shaped the way the student's own forward reads it."""
    from .data import Ms1mShardDataset, collate, normalize_batch, read_identities

    dataset = Ms1mShardDataset(
        root=Path(cfg.data.params["shards"]),
        identities=read_identities(Path(split or cfg.data.split_files[1])),
        size=int(cfg.model.input_hw[0]),
        train=False,
        seed=cfg.run.seed,
    )
    loader = torch.utils.data.DataLoader(dataset, batch_size=samples, collate_fn=collate)
    for images, _targets in loader:
        yield normalize_batch(images)
        return
