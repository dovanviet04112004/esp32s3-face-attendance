# ---
# jupyter:
#   jupytext:
#     text_representation:
#       extension: .py
#       format_name: percent
#   kernelspec:
#     display_name: facepipe
#     language: python
#     name: python3
# ---

# %% [markdown]
# # CelebA-Spoof: which split measures what
#
# A CDCN++ teacher read 0.0134 EER on the mirror's `valid` and 0.1365 on its
# `test`, with APCER at 0.4028 while BPCER stayed at 0.0147. Ten times worse on
# one split than the other, and the errors all on the attack side.
#
# This notebook is the investigation that found why, kept because the answer
# changed the branch's split and its augmentation. Run it against the raw mirror.

# %%
import io
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
from PIL import Image

sys.path.insert(0, "../src")

RAW = Path("../data/raw/antispoof/celeba_spoof/data")
CROPS = Path("../data/interim/antispoof/celeba_spoof_crops")
SPLITS = ("train", "valid", "test")

# %% [markdown]
# ## 1. The mirror ships three splits, and no identity labels
#
# The original layout is `Data/<subject>/live|spoof/*.png` plus a `metas/` tree
# holding 43 annotations per image, spoof type among them. This mirror is
# parquet with three columns, and `metas/` is empty. So subject overlap between
# splits cannot be checked, and neither can attack-type coverage.

# %%
for split in SPLITS:
    handle = pq.ParquetFile(sorted(RAW.glob(f"{split}-*.parquet"))[0])
    print(f"{split:6} columns={handle.schema_arrow.names}  rows/shard={handle.metadata.num_rows}")

# %% [markdown]
# `Filepath` holds image bytes, not a path: the subject id that the original
# directory layout carried is gone.

# %%
for split in SPLITS:
    counts = Counter()
    for path in sorted(RAW.glob(f"{split}-*.parquet"))[:4]:
        counts.update(pq.read_table(path, columns=["Class"]).column("Class").to_pylist())
    total = sum(counts.values())
    shares = "  ".join(f"{k}={v} ({v / total:.1%})" for k, v in sorted(counts.items()))
    print(f"{split:6} {shares}")

# %% [markdown]
# Both classes are present everywhere, so nothing is missing in that sense. The
# `Class` column is binary, so which *kind* of attack each split holds is not
# answerable from this mirror.

# %% [markdown]
# ## 2. The finding: train and valid are one pool, test is another
#
# Same pixel count, six times the bytes. Test is stored at far lower JPEG loss.

# %%
for split in SPLITS:
    files = sorted(RAW.glob(f"{split}-*.parquet"))
    picks = [files[i] for i in (0, len(files) // 3, 2 * len(files) // 3, len(files) - 1)]
    kilobytes, dims = [], []
    for path in picks:
        for row in pq.read_table(path, columns=["Filepath"]).to_pylist()[:150]:
            raw = row["Filepath"]["bytes"]
            kilobytes.append(len(raw) / 1024)
            with Image.open(io.BytesIO(raw)) as image:
                dims.append(image.size)
    kb = np.array(kilobytes)
    width = int(np.median([d[0] for d in dims]))
    height = int(np.median([d[1] for d in dims]))
    print(
        f"{split:6} {width}x{height}  median {np.median(kb):6.1f} KB   "
        f"under 150 KB {np.mean(kb < 150):5.1%}   over 300 KB {np.mean(kb > 300):5.1%}"
    )

# %% [markdown]
# 98% of train and 97% of valid sit under 150 KB; 87% of test sits above 300.
# The two distributions barely touch, so `valid` measures how well a model fits
# the compression the training set happens to carry, not how well it generalises.
#
# A model free to read blocking artefacts will read them: a screen photographed
# and saved at heavy loss carries a signature, and every attack in the training
# pool has it. That is the shape of the error — attacks accepted, live faces
# still recognised.

# %% [markdown]
# ## 3. What the branch does about it
#
# Validation moved into `test` (`test:0:10` against `test:10:` held out), and
# training re-encodes each crop at a quality drawn from 30 to 95 so compression
# stops predicting the label. Both are in `configs/antispoof/`.
#
# The cut is by shard, which buys reproducibility, not identity separation: with
# no identity labels a person can still appear on both sides.

# %%
for split in SPLITS:
    shards = sorted((CROPS / split).glob("shard_*.tar"))
    print(f"{split:6} {len(shards):>3} crop shards")

# %% [markdown]
# ## 4. What is still unmeasured
#
# Which attack types the model fails on. The mirror dropped the labels, so the
# answer has to come from the four cross-domain sets in `data/raw/antispoof/
# xdomain/` — NUAA print, UniqueData replay, AxonData latex and silicone masks —
# which carry their own type labels and are held for exactly this.
