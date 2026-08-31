"""CelebA-Spoof shards to batches of two crops and a label.

Records are read front to back, never seeked: that is the whole reason the crops
were packed into shards (KEHOACH section 4.4.1). Shuffling therefore happens in
two places that together approximate a shuffled epoch - the shard order, and a
buffer of records held back before yielding.

The pair of crops belongs to one face. Feeding a tight crop with another face's
wide crop teaches the model that context and face are unrelated, which is the
opposite of what the branch is for.
"""

from __future__ import annotations

import io
import json
import random
import tarfile
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch.utils.data import IterableDataset, get_worker_info

from facepipe.data.prepare.images_to_wds import read_shard

CROP_SIZE = 80
SHUFFLE_BUFFER = 2048


@dataclass
class SpoofSample:
    """One face: the tight view, the context view, and whether it is an attack."""

    tight: np.ndarray
    wide: np.ndarray
    label: int


def shard_paths(root: Path) -> list[Path]:
    return sorted(Path(root).glob("shard_*.tar"))


def count_records(shards: list[Path], shard_size: int = 2000) -> int:
    """Total records without reading every shard.

    Every shard but the last holds shard_size records by construction, so only
    the last one has to be opened.
    """
    if not shards:
        return 0
    with tarfile.open(shards[-1], "r|") as archive:
        tail = sum(1 for member in archive if member.name.endswith(".json"))
    return (len(shards) - 1) * shard_size + tail


def decode(payload: bytes, size: int) -> np.ndarray:
    with Image.open(io.BytesIO(payload)) as handle:
        image = handle.convert("RGB")
        if image.size != (size, size):
            image = image.resize((size, size), Image.BILINEAR)
        return np.array(image, dtype=np.uint8)


def horizontal_flip(sample: SpoofSample) -> SpoofSample:
    """Mirror both views together; a face and its context are one scene."""
    return SpoofSample(sample.tight[:, ::-1].copy(), sample.wide[:, ::-1].copy(), sample.label)


class SpoofShardDataset(IterableDataset):
    """Streams (tight, wide, label) from one split's shards."""

    def __init__(
        self,
        root: Path,
        size: int = CROP_SIZE,
        train: bool = True,
        seed: int = 42,
        shuffle_buffer: int = SHUFFLE_BUFFER,
    ) -> None:
        self.shards = shard_paths(root)
        if not self.shards:
            raise FileNotFoundError(f"{root}: no shard_*.tar")
        self.size = size
        self.train = train
        self.seed = seed
        self.shuffle_buffer = shuffle_buffer if train else 0
        self.epoch = 0
        self._length = count_records(self.shards)

    def __len__(self) -> int:
        return self._length

    def _my_shards(self) -> list[Path]:
        """This worker's slice of the shard list.

        Without the split every worker would read every shard, so an epoch would
        train on each record num_workers times while the logs showed one pass.
        """
        info = get_worker_info()
        shards = list(self.shards)
        if self.train:
            random.Random(self.seed + self.epoch).shuffle(shards)
        if info is None:
            return shards
        return shards[info.id :: info.num_workers]

    def _records(self) -> Iterator[SpoofSample]:
        for shard in self._my_shards():
            for record in read_shard(shard):
                meta = json.loads(record["json"])
                yield SpoofSample(
                    tight=decode(record["tight.jpg"], self.size),
                    wide=decode(record["wide.jpg"], self.size),
                    label=int(meta["label"]),
                )

    def __iter__(self) -> Iterator[SpoofSample]:
        info = get_worker_info()
        rng = random.Random(self.seed + self.epoch + (info.id if info else 0))
        buffer: list[SpoofSample] = []
        for sample in self._records():
            if self.train and rng.random() < 0.5:
                sample = horizontal_flip(sample)
            if self.shuffle_buffer <= 0:
                yield sample
                continue
            buffer.append(sample)
            if len(buffer) >= self.shuffle_buffer:
                index = rng.randrange(len(buffer))
                buffer[index], buffer[-1] = buffer[-1], buffer[index]
                yield buffer.pop()
        rng.shuffle(buffer)
        yield from buffer


def to_tensor(image: np.ndarray) -> torch.Tensor:
    return torch.from_numpy(image).permute(2, 0, 1).float().div_(255.0)


def collate(batch: list[SpoofSample]) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """Stack into (tight, wide, label), the triple the model and loss expect."""
    tight = torch.stack([to_tensor(s.tight) for s in batch])
    wide = torch.stack([to_tensor(s.wide) for s in batch])
    labels = torch.tensor([s.label for s in batch], dtype=torch.long)
    return tight, wide, labels
