"""Run the teacher over every shard once and keep its 512-D answers on disk.

The teacher is forty times the student's cost per image. Running it inside the
training loop would make the distilled arm several times slower than the baseline
it is being compared against, and the ablation would then be measuring patience
rather than method (KEHOACH section 3.7). Its output depends only on the image,
so it is computed once here and read back as fast as the shards themselves.

Rows are addressed by the record's key, which is its position in the original
RecordIO. Shards therefore write disjoint contiguous stretches, and a run that
dies part way can resume at a shard boundary without recomputing what it has.

The only augmentation the branch applies is a horizontal flip, and a flip does
not move a face on the unit sphere far enough to matter here: one embedding per
image is cached, and the student sees it whichever way its own copy was flipped.

Usage:
    python -m facepipe.tasks.recognition.teacher.export_embedding \\
        --shards data/interim/recognition/ms1mv3_shards \\
        --weights artifacts/recognition/teacher/w600k_r50.pth \\
        --out artifacts/recognition/teacher/ms1mv3_embeddings.f16
"""

from __future__ import annotations

import argparse
import json
import time
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import torch

from facepipe.data.prepare.images_to_wds import KEY_FIELD, read_shard

from ..data import TEACHER_DTYPE, decode, shard_paths
from .r50_wf600k import EMBEDDING_DIM, load_r50_wf600k, normalize_pixels

BATCH_SIZE = 128
PROGRESS_SUFFIX = ".progress.json"


def last_key(shard: Path) -> int:
    """Highest record key in one shard, which sizes the output when it is the last."""
    return max(int(record[KEY_FIELD]) for record in read_shard(shard))


def open_cache(path: Path, rows: int, dim: int = EMBEDDING_DIM) -> np.memmap:
    """Create or reopen the memmap, keeping what a previous attempt wrote."""
    mode = "r+" if path.is_file() else "w+"
    return np.memmap(path, dtype=TEACHER_DTYPE, mode=mode, shape=(rows, dim))


def read_progress(path: Path) -> set[str]:
    if not path.is_file():
        return set()
    return set(json.loads(path.read_text(encoding="utf-8"))["done"])


def write_progress(path: Path, done: set[str]) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"done": sorted(done)}), encoding="utf-8")
    tmp.replace(path)


def batches(shard: Path, size: int) -> Iterator[tuple[list[int], np.ndarray]]:
    """Group one shard's records into fixed-size batches of decoded images."""
    keys: list[int] = []
    images: list[np.ndarray] = []
    for record in read_shard(shard):
        keys.append(int(record[KEY_FIELD]))
        images.append(decode(record["jpg"]))
        if len(keys) == size:
            yield keys, np.stack(images)
            keys, images = [], []
    if keys:
        yield keys, np.stack(images)


@torch.no_grad()
def embed_shard(
    model: torch.nn.Module, shard: Path, cache: np.memmap, device: torch.device, size: int
) -> int:
    """Write every record of one shard into the cache, returning how many."""
    written = 0
    for keys, images in batches(shard, size):
        tensor = torch.from_numpy(images).permute(0, 3, 1, 2).to(device).float()
        with torch.autocast(device.type, dtype=torch.float16, enabled=device.type == "cuda"):
            embeddings = model(normalize_pixels(tensor))
        cache[keys] = embeddings.float().cpu().numpy().astype(TEACHER_DTYPE)
        written += len(keys)
    return written


def export(
    shards_root: Path,
    weights: Path,
    out: Path,
    batch_size: int = BATCH_SIZE,
    device_name: str = "auto",
) -> dict:
    """Cache the teacher's embedding for every record under shards_root."""
    shards = shard_paths(shards_root)
    if not shards:
        raise FileNotFoundError(f"{shards_root}: no *.tar")

    device = torch.device(
        ("cuda" if torch.cuda.is_available() else "cpu") if device_name == "auto" else device_name
    )
    model = load_r50_wf600k(weights).to(device).eval()

    out.parent.mkdir(parents=True, exist_ok=True)
    cache = open_cache(out, rows=last_key(shards[-1]) + 1)
    progress_path = out.with_suffix(out.suffix + PROGRESS_SUFFIX)
    done = read_progress(progress_path)

    stats = {"shards": len(shards), "skipped": len(done), "records": 0, "seconds": 0.0}
    started = time.perf_counter()
    for shard in shards:
        if shard.name in done:
            continue
        stats["records"] += embed_shard(model, shard, cache, device, batch_size)
        cache.flush()
        done.add(shard.name)
        write_progress(progress_path, done)
    stats["seconds"] = round(time.perf_counter() - started, 1)
    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shards", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--device", default="auto")
    args = parser.parse_args(argv)

    stats = export(args.shards, args.weights, args.out, args.batch_size, args.device)
    print(f"{args.out}: {stats}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
