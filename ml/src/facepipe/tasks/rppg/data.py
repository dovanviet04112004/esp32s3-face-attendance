"""Which clips the rPPG measurement reads, and what each one is (KEHOACH 3, 1.2).

UniqueData gives both sides, paired by person; Axon gives attacks only, because its
Selfies folder holds stills. An Axon folder holding video must map to a class here,
so a new folder fails loudly instead of being scored as nothing.
"""

from __future__ import annotations

import csv
import os
from dataclasses import dataclass
from pathlib import Path

VIDEO_SUFFIXES = frozenset({".mp4", ".mov"})
UNIQUE_MANIFEST = "anti-spoofing_replay.csv"
KINDS = ("live", "paper", "mask", "replay")
AXON_KINDS = {
    "cutout_attacks": "paper",
    "3d_paper_mask": "paper",
    "wrapped_3d_paper_mask": "paper",
    "silicone_mask": "mask",
    "latex_mask": "mask",
    "textile_3d_face_mask_attack_sample": "mask",
    "replay_mobile_attacks": "replay",
    "replay_display_attacks": "replay",
}


@dataclass(frozen=True)
class Clip:
    """One video, its class, and the person in it when the set records one."""

    name: str
    path: Path
    kind: str
    source: str
    person: str


def folder_key(name: str) -> str:
    return name.strip().replace(" ", "_").lower()


def video_in(folder: Path) -> Path | None:
    if not folder.is_dir():
        return None
    found = sorted(
        p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in VIDEO_SUFFIXES
    )
    return found[0] if found else None


def unique_rows(root: Path) -> list[dict[str, str]]:
    with (Path(root) / UNIQUE_MANIFEST).open(encoding="utf-8", newline="") as handle:
        return [
            {key.strip(): value.strip() for key, value in row.items()}
            for row in csv.DictReader(handle, delimiter=";")
        ]


def unique_clips(root: Path) -> list[Clip]:
    """Each live clip and the replay filmed from it, under the worker who sat for both."""
    root = Path(root)
    clips: dict[str, Clip] = {}
    for row in unique_rows(root):
        person = row["worker_id"]
        live = video_in(root / "live" / row["live_video_id"])
        if live is not None:
            name = f"live_{row['live_video_id']}"
            clips.setdefault(name, Clip(name, live, "live", "unique_live", person))
        folder = Path(row["link"]).parent.name
        replay = video_in(root / "replay" / folder)
        if replay is not None:
            name = f"replay_{folder}"
            clips.setdefault(name, Clip(name, replay, "replay", "unique_replay", person))
    return list(clips.values())


def video_files(root: Path) -> list[Path]:
    """Every video under `root`, through the per-folder symlinks data/raw is built from."""
    found = []
    for folder, _, files in os.walk(root, followlinks=True):
        found += [
            Path(folder) / name for name in files if Path(name).suffix.lower() in VIDEO_SUFFIXES
        ]
    return sorted(found)


def axon_clips(root: Path) -> list[Clip]:
    root = Path(root)
    clips: list[Clip] = []
    for path in video_files(root):
        parts = path.relative_to(root).with_suffix("").parts
        folder = folder_key(parts[0])
        if folder not in AXON_KINDS:
            raise ValueError(f"{path}: Axon folder {parts[0]!r} holds video but has no class")
        name = "_".join(folder_key(part) for part in parts[1:])
        clips.append(Clip(name, path, AXON_KINDS[folder], f"axon_{folder}", ""))
    return clips
