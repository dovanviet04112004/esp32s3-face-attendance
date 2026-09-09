"""Shared training infrastructure.

All three branches import these modules. Nothing here may name a branch or
import from facepipe.tasks; see KEHOACH 4.4.3.
"""

from facepipe.core.config import (
    Config,
    config_hash,
    dump_config,
    load_config,
    load_run_config,
)
from facepipe.core.logger import RunLogger, setup_console_logging
from facepipe.core.metrics import AverageMeter, MetricTracker, Throughput
from facepipe.core.registry import (
    DATASETS,
    LOSSES,
    MODELS,
    OPTIMIZERS,
    SCHEDULERS,
    TRANSFORMS,
    Registry,
    RegistryError,
)
from facepipe.core.run_dir import RunDir, create_run_dir, git_sha7
from facepipe.core.scheduler import build_optimizer, build_scheduler
from facepipe.core.seed import seed_everything, worker_init_fn
from facepipe.core.trainer import ModelEma, Trainer, TrainState, resolve_device

__all__ = [
    "DATASETS",
    "LOSSES",
    "MODELS",
    "OPTIMIZERS",
    "SCHEDULERS",
    "TRANSFORMS",
    "AverageMeter",
    "Config",
    "MetricTracker",
    "ModelEma",
    "Registry",
    "RegistryError",
    "RunDir",
    "RunLogger",
    "Throughput",
    "TrainState",
    "Trainer",
    "build_optimizer",
    "build_scheduler",
    "config_hash",
    "create_run_dir",
    "dump_config",
    "git_sha7",
    "load_config",
    "load_run_config",
    "resolve_device",
    "seed_everything",
    "setup_console_logging",
    "worker_init_fn",
]
