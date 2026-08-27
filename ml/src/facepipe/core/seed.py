"""Seed control and RNG state capture.

Reproducibility is a hard requirement here: the ablation tables of sections 3.7
and 3.8 compare arms, and two arms that differ in seed cannot be compared.
"""

from __future__ import annotations

import os
import random
from dataclasses import dataclass
from typing import Any

import numpy as np
import torch


@dataclass(frozen=True)
class SeedConfig:
    """Seeding policy for one run."""

    seed: int = 42
    deterministic: bool = True
    cudnn_benchmark: bool = False


def seed_everything(seed: int, deterministic: bool = True, cudnn_benchmark: bool = False) -> None:
    """Seed python, numpy and torch, and pin cuDNN behaviour.

    Deterministic mode trades throughput for repeatability; leave it on for any
    run whose numbers end up in a comparison table.
    """
    os.environ["PYTHONHASHSEED"] = str(seed)
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.benchmark = cudnn_benchmark
    if deterministic:
        torch.backends.cudnn.deterministic = True
        torch.use_deterministic_algorithms(True, warn_only=True)
        # cuBLAS reductions are nondeterministic without this workspace setting.
        os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")


def apply_seed_config(cfg: SeedConfig) -> None:
    """Apply a SeedConfig."""
    seed_everything(cfg.seed, cfg.deterministic, cfg.cudnn_benchmark)


def worker_init_fn(worker_id: int) -> None:
    """DataLoader worker seeding, so each worker draws a distinct stream."""
    base = torch.initial_seed() % 2**31
    random.seed(base + worker_id)
    np.random.seed((base + worker_id) % 2**31)


def capture_rng_state() -> dict[str, Any]:
    """Snapshot every RNG stream, for checkpointing."""
    state: dict[str, Any] = {
        "python": random.getstate(),
        "numpy": np.random.get_state(),
        "torch": torch.get_rng_state(),
    }
    if torch.cuda.is_available():
        state["torch_cuda"] = torch.cuda.get_rng_state_all()
    return state


def restore_rng_state(state: dict[str, Any]) -> None:
    """Restore a snapshot from capture_rng_state, so a resumed run draws the same stream."""
    random.setstate(state["python"])
    np.random.set_state(state["numpy"])
    torch.set_rng_state(_as_byte_tensor(state["torch"]))
    cuda_state = state.get("torch_cuda")
    if cuda_state is not None and torch.cuda.is_available():
        torch.cuda.set_rng_state_all([_as_byte_tensor(s) for s in cuda_state])


def _as_byte_tensor(value: Any) -> torch.Tensor:
    tensor = value if isinstance(value, torch.Tensor) else torch.tensor(value)
    return tensor.cpu().to(torch.uint8)
