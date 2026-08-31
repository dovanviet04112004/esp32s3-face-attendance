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
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch.utils.data import IterableDataset, get_worker_info

from facepipe.data.prepare.images_to_wds import read_shard

CROP_SIZE = 80
SHUFFLE_BUFFER = 2048
# Spans both pools the branch meets, so neither end can cue the label (KEHOACH 1.3).
QUALITY_RANGE = (30, 95)
RECOMPRESS_PROBABILITY = 0.5


@dataclass
class SpoofSample:
    """One face: the tight view, the context view, and whether it is an attack."""

    tight: np.ndarray
    wide: np.ndarray
    label: int


def shard_paths(root: Path) -> list[Path]:
    return sorted(Path(root).glob("shard_*.tar"))


def resolve_spec(root: Path, spec: str) -> list[Path]:
    """Shards named by "split" or by "split:start:end", the end exclusive.

    Slicing by shard buys reproducibility, not identity separation: the mirror
    ships no identity labels and its own ordering already interleaves the two
    classes, so a person can appear on both sides of a cut (SPLIT.md).
    """
    parts = str(spec).split(":")
    shards = shard_paths(Path(root) / parts[0])
    if not shards:
        raise FileNotFoundError(f"{Path(root) / parts[0]}: no shard_*.tar")
    if len(parts) == 1:
        return shards
    if len(parts) != 3:
        raise ValueError(f"{spec!r}: expected 'split' or 'split:start:end'")
    start = int(parts[1]) if parts[1] else 0
    end = int(parts[2]) if parts[2] else len(shards)
    chosen = shards[start:end]
    if not chosen:
        raise ValueError(f"{spec!r} selects nothing from {len(shards)} shards")
    return chosen


def resolve_splits(root: Path, specs: str | Sequence[str]) -> tuple[list[Path], int]:
    """Every shard the specs name, and an exact record count for them.

    Counted per spec, not over the merged list: only the last shard of a run is
    short, and merging buries the short ones where the arithmetic would skip them.
    """
    if isinstance(specs, str):
        specs = [specs]
    shards: list[Path] = []
    total = 0
    for spec in specs:
        chosen = resolve_spec(root, spec)
        shards.extend(chosen)
        total += count_records(chosen)
    return shards, total


def records_in(shard: Path) -> int:
    """How many records one shard holds, by reading its member names."""
    with tarfile.open(shard, "r|") as archive:
        return sum(1 for member in archive if member.name.endswith(".json"))


def count_records(shards: list[Path], shard_size: int | None = None) -> int:
    """Total records without reading every shard.

    Shards hold a fixed size, so the first one measures it and only the last,
    which may be short, has to be counted too.
    """
    if not shards:
        return 0
    if len(shards) == 1:
        return records_in(shards[0])
    full = shard_size if shard_size is not None else records_in(shards[0])
    return (len(shards) - 1) * full + records_in(shards[-1])


def decode(payload: bytes, size: int) -> np.ndarray:
    with Image.open(io.BytesIO(payload)) as handle:
        image = handle.convert("RGB")
        if image.size != (size, size):
            image = image.resize((size, size), Image.BILINEAR)
        return np.array(image, dtype=np.uint8)


def horizontal_flip(sample: SpoofSample) -> SpoofSample:
    """Mirror both views together; a face and its context are one scene."""
    return SpoofSample(sample.tight[:, ::-1].copy(), sample.wide[:, ::-1].copy(), sample.label)


def requantise(image: np.ndarray, quality: int) -> np.ndarray:
    """Re-encode one view as JPEG at the given quality and decode it back."""
    buffer = io.BytesIO()
    Image.fromarray(image).save(buffer, format="JPEG", quality=quality)
    buffer.seek(0)
    with Image.open(buffer) as handle:
        return np.array(handle.convert("RGB"), dtype=np.uint8)


def recompress(sample: SpoofSample, quality: int) -> SpoofSample:
    """Put both views through one JPEG quality, so compression cannot carry the label.

    Measured: the training pool is 450x600 at a median 72 KB and the graded pool
    480x600 at 471 KB, so blocking artefacts separate the two on their own.
    """
    return SpoofSample(
        requantise(sample.tight, quality), requantise(sample.wide, quality), sample.label
    )


class SpoofShardDataset(IterableDataset):
    """Streams (tight, wide, label) from one split's shards."""

    def __init__(
        self,
        root: Path,
        size: int = CROP_SIZE,
        train: bool = True,
        seed: int = 42,
        shuffle_buffer: int = SHUFFLE_BUFFER,
        splits: str | Sequence[str] | None = None,
        recompress_probability: float = RECOMPRESS_PROBABILITY,
        quality_range: tuple[int, int] = QUALITY_RANGE,
    ) -> None:
        if splits is None:
            self.shards = shard_paths(root)
            if not self.shards:
                raise FileNotFoundError(f"{root}: no shard_*.tar")
            self._length = count_records(self.shards)
        else:
            self.shards, self._length = resolve_splits(root, splits)
        self.size = size
        self.train = train
        self.seed = seed
        self.shuffle_buffer = shuffle_buffer if train else 0
        self.recompress_probability = recompress_probability
        self.quality_range = quality_range
        self.epoch = 0

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
            if self.train and rng.random() < self.recompress_probability:
                sample = recompress(sample, rng.randint(*self.quality_range))
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
