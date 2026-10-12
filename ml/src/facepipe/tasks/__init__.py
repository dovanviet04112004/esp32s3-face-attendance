"""One package per model branch; branches never import each other.

A run names its branch in run.task, the folder its artifacts live under (KEHOACH 4.4.3), so the
helpers here reach a run's own branch without a table of model names.
"""

from __future__ import annotations

import importlib
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

from facepipe.core.config import load_run_config


def branch_of(run: Path) -> str:
    return load_run_config(run).run.task


def module_of(run: Path, name: str) -> ModuleType:
    """The run's branch module name, such as eval or quant."""
    return importlib.import_module(f"{__name__}.{branch_of(run)}.{name}")


def load_run(run: Path):
    """The run's config and model as its branch rebuilds them, config filled from the weights."""
    return module_of(run, "eval").load_run(run)


def calibration_samples(run: Path, split: str | None, limit: int) -> Iterator[dict]:
    """The branch's representative samples for the run, keyed by graph input, NHWC."""
    cfg = load_run(run)[0]
    yield from module_of(run, "quant").calibration_batches(cfg, split, limit)
