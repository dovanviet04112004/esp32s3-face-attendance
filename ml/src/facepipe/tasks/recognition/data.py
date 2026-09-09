"""MS1MV3 shards to batches of aligned faces and labels.

Images arrive aligned to the ArcFace reference at 112x112, the geometry the
device reproduces, so nothing here warps anything and augmentation is a flip.
Records stream front to back, shuffled by shard order plus a held-back buffer
(KEHOACH 4.4.1). Labels renumber this run's own split (KEHOACH 1.3).
"""

from __future__ import annotations

import io
import json
import random
from collections import deque
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch.utils.data import IterableDataset, get_worker_info

from facepipe.data.prepare.images_to_wds import read_shard

from .postproc.align import ALIGNED_SIZE

PIXEL_MEAN = 127.5
PIXEL_SCALE = 127.5
# A buffered sample is 37 KB, so the buffer costs this many megabytes in every
# worker process at once; twenty readers on a 9 GB host cannot afford more.
SHUFFLE_BUFFER = 2048
OPEN_SHARDS = 4
COUNTS_NAME = "record_counts.json"


@dataclass
class RecogSample:
    """One face: the aligned crop and its class index."""

    image: np.ndarray
    label: int


@dataclass
class RecogTargets:
    """What a batch is scored against."""

    labels: torch.Tensor


def shard_paths(root: Path) -> list[Path]:
    return sorted(Path(root).glob("*.tar"))


def read_identities(path: Path) -> list[int]:
    """Identity indices from a split file, one per line, ignoring any suffix."""
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    return [int(line.strip().split("/")[0]) for line in lines if line.strip()]


def label_map(identities: list[int]) -> dict[int, int]:
    """Original identity index to a contiguous class index, in sorted order."""
    return {identity: index for index, identity in enumerate(sorted(set(identities)))}


def decode(payload: bytes, size: int = ALIGNED_SIZE) -> np.ndarray:
    with Image.open(io.BytesIO(payload)) as handle:
        image = handle.convert("RGB")
        if image.size != (size, size):
            image = image.resize((size, size), Image.BILINEAR)
        return np.array(image, dtype=np.uint8)


def normalize_batch(images: torch.Tensor) -> torch.Tensor:
    """Bytes to the [-1, 1] range both models were trained in.

    Done on the accelerator rather than in the loader: a normalised batch is four
    times the bytes of a byte batch, and that difference is paid on every host to
    device copy for the whole run.
    """
    return (images.float() - PIXEL_MEAN) / PIXEL_SCALE


class Ms1mShardDataset(IterableDataset):
    """Streams (image, label) for one side of the split."""

    def __init__(
        self,
        root: Path,
        identities: list[int],
        size: int = ALIGNED_SIZE,
        train: bool = True,
        seed: int = 42,
        embedding_dim: int = 512,
        shuffle_buffer: int = SHUFFLE_BUFFER,
        open_shards: int = OPEN_SHARDS,
    ) -> None:
        self.shards = shard_paths(root)
        if not self.shards:
            raise FileNotFoundError(f"{root}: no *.tar")
        self.labels = label_map(identities)
        self.size = size
        self.train = train
        self.seed = seed
        self.shuffle_buffer = shuffle_buffer if train else 0
        self.open_shards = max(1, open_shards if train else 1)
        self.embedding_dim = embedding_dim
        self.epoch = 0
        self._cache: np.memmap | None = None
        self._length = 0

    @property
    def num_classes(self) -> int:
        return len(self.labels)

    def __len__(self) -> int:
        if not self._length:
            self._length = self.count_records()
        return self._length

    def count_records(self) -> int:
        """How many records this split keeps, read from a sidecar or counted once.

        Counting streams all 36 GB and costs 31 minutes (measurements 1), which
        the LR schedule would otherwise pay on every run and resume. The answer
        depends only on the shards and identity list, so it is keyed by both.
        """
        sidecar = self.shards[0].parent / COUNTS_NAME
        key = f"{len(self.labels)}:{min(self.labels, default=-1)}:{max(self.labels, default=-1)}"
        cached = json.loads(sidecar.read_text(encoding="utf-8")) if sidecar.is_file() else {}
        if key in cached:
            return int(cached[key])

        kept = sum(1 for shard in self.shards for record in read_shard(shard) if self.keeps(record))
        cached[key] = kept
        sidecar.write_text(json.dumps(cached, sort_keys=True), encoding="utf-8")
        return kept

    def keeps(self, record: dict[str, bytes]) -> bool:
        return int(record["cls"]) in self.labels

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

    def _interleaved(self, shards: list[Path]) -> Iterator[dict[str, bytes]]:
        """Take one record from each of several shards in turn.

        MS1MV3 stores a person's photographs back to back, so one stream hands
        the shuffle buffer a single identity at a time. Rotation multiplies the
        identities in flight while each stream still reads sequentially.
        """
        streams: deque[Iterator[dict[str, bytes]]] = deque()
        waiting = iter(shards)
        while True:
            while len(streams) < self.open_shards:
                shard = next(waiting, None)
                if shard is None:
                    break
                streams.append(read_shard(shard))
            if not streams:
                return
            stream = streams.popleft()
            record = next(stream, None)
            if record is None:
                continue
            streams.append(stream)
            yield record

    def _records(self) -> Iterator[RecogSample]:
        for record in self._interleaved(self._my_shards()):
            if not self.keeps(record):
                continue
            yield RecogSample(
                image=decode(record["jpg"], self.size),
                label=self.labels[int(record["cls"])],
            )

    def __iter__(self) -> Iterator[RecogSample]:
        info = get_worker_info()
        rng = random.Random(self.seed + self.epoch + (info.id if info else 0))
        buffer: list[RecogSample] = []
        for sample in self._records():
            if self.train and rng.random() < 0.5:
                sample = RecogSample(sample.image[:, ::-1].copy(), sample.label)
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


def collate(batch: list[RecogSample]) -> tuple[torch.Tensor, RecogTargets]:
    """Stack into byte images and the targets they are scored against."""
    images = torch.from_numpy(np.stack([s.image for s in batch])).permute(0, 3, 1, 2).contiguous()
    labels = torch.tensor([s.label for s in batch], dtype=torch.long)
    return images, RecogTargets(labels=labels)
