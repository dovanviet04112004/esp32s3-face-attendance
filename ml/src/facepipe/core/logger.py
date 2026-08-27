"""Console, TensorBoard and optional wandb logging behind one object."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

LOG_FORMAT = "%(asctime)s %(levelname)-7s %(name)s | %(message)s"
DATE_FORMAT = "%H:%M:%S"


def setup_console_logging(level: str = "INFO") -> None:
    """Install a single stream handler; safe to call more than once."""
    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(level=level, format=LOG_FORMAT, datefmt=DATE_FORMAT)
    root.setLevel(level)


class RunLogger:
    """Scalar and text sink for one run.

    TensorBoard and wandb are both optional; when neither is on the object still
    works and only writes to the console and metrics.json.
    """

    def __init__(
        self,
        run_dir: Path,
        *,
        tensorboard: bool = True,
        wandb: bool = False,
        wandb_project: str = "facepipe",
        run_name: str | None = None,
        config: dict[str, Any] | None = None,
        level: str = "INFO",
    ) -> None:
        setup_console_logging(level)
        self.run_dir = Path(run_dir)
        self.log = logging.getLogger("facepipe")
        self._history: list[dict[str, Any]] = []
        self._writer = self._open_tensorboard(tensorboard)
        self._wandb = self._open_wandb(wandb, wandb_project, run_name, config)

    def _open_tensorboard(self, enabled: bool) -> Any:
        if not enabled:
            return None
        try:
            from torch.utils.tensorboard import SummaryWriter
        except ImportError:
            self.log.warning("tensorboard absent, scalar logging goes to metrics.json only")
            return None
        return SummaryWriter(log_dir=str(self.run_dir / "tb"))

    def _open_wandb(
        self, enabled: bool, project: str, run_name: str | None, config: dict[str, Any] | None
    ) -> Any:
        if not enabled:
            return None
        try:
            import wandb
        except ImportError:
            self.log.warning("wandb absent, install the track extra to enable it")
            return None
        return wandb.init(project=project, name=run_name, config=config, dir=str(self.run_dir))

    def info(self, message: str) -> None:
        self.log.info(message)

    def warning(self, message: str) -> None:
        self.log.warning(message)

    def log_scalars(self, step: int, prefix: str = "", **values: float) -> None:
        """Send scalars to every active sink and keep them for metrics.json."""
        record: dict[str, Any] = {"step": step}
        for key, value in values.items():
            tag = f"{prefix}/{key}" if prefix else key
            record[tag] = float(value)
            if self._writer is not None:
                self._writer.add_scalar(tag, float(value), step)
        if self._wandb is not None:
            self._wandb.log({k: v for k, v in record.items() if k != "step"}, step=step)
        self._history.append(record)

    def log_hparams(self, hparams: dict[str, Any], metrics: dict[str, float]) -> None:
        if self._writer is not None:
            flat = {k: v for k, v in hparams.items() if isinstance(v, int | float | str | bool)}
            self._writer.add_hparams(flat, metrics)

    def dump_metrics(self, path: Path | None = None) -> Path:
        """Write the scalar history as metrics.json."""
        target = Path(path) if path else self.run_dir / "metrics.json"
        target.write_text(json.dumps(self._history, indent=2), encoding="utf-8")
        return target

    def close(self) -> None:
        self.dump_metrics()
        if self._writer is not None:
            self._writer.flush()
            self._writer.close()
        if self._wandb is not None:
            self._wandb.finish()

    def __enter__(self) -> RunLogger:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
