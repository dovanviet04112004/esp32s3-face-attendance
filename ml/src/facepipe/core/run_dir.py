"""Immutable run directories.

Layout follows KEHOACH 4.4.3: artifacts/<task>/runs/<stamp>_<gitsha7>_<cfghash6>/.
The trail back is models.lock.json -> run_id -> this directory ->
config.resolved.yaml, split.lock, env.txt, ckpt/.
"""

from __future__ import annotations

import hashlib
import platform
import subprocess
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from facepipe.core.config import Config, config_hash, dump_config

CONFIG_NAME = "config.resolved.yaml"
SPLIT_LOCK_NAME = "split.lock"
ENV_NAME = "env.txt"
METRICS_NAME = "metrics.json"
CKPT_DIR = "ckpt"
TB_DIR = "tb"


@dataclass(frozen=True)
class RunDir:
    """A created run directory and the identifiers that name it."""

    path: Path
    task: str
    run_id: str

    @property
    def ckpt_dir(self) -> Path:
        return self.path / CKPT_DIR

    @property
    def tb_dir(self) -> Path:
        return self.path / TB_DIR

    @property
    def metrics_path(self) -> Path:
        return self.path / METRICS_NAME


def git_sha7(default: str = "nogit") -> str:
    """Short commit hash, with a `-dirty` suffix when the tree has changes."""
    try:
        sha = subprocess.run(
            ["git", "rev-parse", "--short=7", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout.strip()
        dirty = subprocess.run(
            ["git", "status", "--porcelain"],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return default
    return f"{sha}-dirty" if dirty else sha


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def shard_tree_digest(root: Path) -> str:
    """Digest a shard tree by the path and size of every file under it.

    Rebuilding shards writes over the same directory, so the path alone cannot
    tell two generations apart and two runs look comparable when they are not.
    """
    if not root.is_dir():
        return "MISSING"
    manifest = sorted(
        f"{item.relative_to(root).as_posix()} {item.stat().st_size}"
        for item in root.rglob("*")
        if item.is_file()
    )
    return hashlib.sha256("\n".join(manifest).encode("utf-8")).hexdigest()


def declared_splits(params: dict[str, object]) -> list[str]:
    """The split a branch names in its params rather than listing as files."""
    keys = sorted(key for key in params if key.endswith("_split") or key == "shards")
    lines = []
    for key in keys:
        lines.append(f"{key}: {params[key]}")
        if key == "shards":
            lines.append(f"shards_digest: {shard_tree_digest(Path(str(params[key])))}")
    return lines


def write_split_lock(
    path: Path, split_files: list[Path], declared: list[str] | None = None
) -> None:
    """Record the digest of every split the run consumed.

    An absent file is MISSING rather than skipped: a run whose data nobody can
    identify must not look reproducible.
    """
    lines = []
    for split in split_files:
        resolved = Path(split)
        digest = sha256_file(resolved) if resolved.is_file() else "MISSING"
        lines.append(f"{digest}  {split}")
    lines = lines or list(declared or []) or ["UNDECLARED"]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_env_txt(path: Path) -> None:
    """Record interpreter, platform, package versions and the commit."""
    lines = [
        f"timestamp_utc: {datetime.now(UTC).isoformat(timespec='seconds')}",
        f"python: {sys.version.split()[0]}",
        f"platform: {platform.platform()}",
        f"machine: {platform.machine()}",
        f"git_sha: {git_sha7()}",
    ]
    lines.extend(_torch_env())
    lines.append("")
    lines.append("# pip freeze")
    lines.extend(_frozen_packages())
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _torch_env() -> list[str]:
    try:
        import torch
    except ImportError:
        return ["torch: absent"]
    out = [f"torch: {torch.__version__}", f"cuda_available: {torch.cuda.is_available()}"]
    if torch.cuda.is_available():
        out.append(f"cuda: {torch.version.cuda}")
        out.extend(
            f"gpu[{i}]: {torch.cuda.get_device_name(i)}" for i in range(torch.cuda.device_count())
        )
    return out


def _frozen_packages() -> list[str]:
    try:
        from importlib.metadata import distributions
    except ImportError:
        return []
    seen = {
        f"{dist.metadata['Name']}=={dist.version}"
        for dist in distributions()
        if dist.metadata.get("Name")
    }
    return sorted(seen)


def make_run_id(cfg: Config, now: datetime | None = None) -> str:
    """Build `<YYYYMMDD-HHMM>_<gitsha7>_<cfghash6>`."""
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M")
    return f"{stamp}_{git_sha7()}_{config_hash(cfg)}"


def create_run_dir(cfg: Config, now: datetime | None = None) -> RunDir:
    """Create the run directory and write the three files that make it replayable.

    Raises if the directory already exists: a run directory is immutable, and
    silently reusing one would mix two runs' checkpoints.
    """
    run_id = make_run_id(cfg, now)
    path = Path(cfg.run.artifacts_root) / cfg.run.task / "runs" / run_id
    path.mkdir(parents=True, exist_ok=False)
    (path / CKPT_DIR).mkdir()
    (path / TB_DIR).mkdir()

    dump_config(cfg, path / CONFIG_NAME)
    write_split_lock(
        path / SPLIT_LOCK_NAME, list(cfg.data.split_files), declared_splits(cfg.data.params)
    )
    write_env_txt(path / ENV_NAME)
    return RunDir(path=path, task=cfg.run.task, run_id=f"{cfg.run.task}/{run_id}")
