#!/usr/bin/env python3
"""Build the English notes of a firmware or models release from git (KEHOACH 7.7).

make release-notes and make models-release print these, then hand them to the server
and to GitHub with the publisher's Vietnamese summary. The notes are only as clear as
the commits under them, which is why tools/check_commit_msg.py guards their format.
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import subprocess
import sys
from pathlib import Path

GROUPS = (("feat", "Features"), ("fix", "Fixes"), ("perf", "Performance"))
OTHER = "Other changes"
SUBJECT_TYPE = re.compile(r"^([a-z]+)(\([^)]*\))?!?: ")
RELEASE_SUBJECT = re.compile(r"^build\(firmware\): release ")
MOST_LINES = 120
BRANCHES = ("detection", "antispoof", "recognition")


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True
    ).stdout


def release_commit(version: str) -> str:
    """The commit that set PROJECT_VER to this version, the oldest if it came back later."""
    found = git(
        "log",
        "--format=%H",
        f'-Sset(PROJECT_VER "{version}")',
        "--",
        "firmware/CMakeLists.txt",
    ).split()
    if not found:
        sys.exit(f"no commit sets PROJECT_VER to {version}")
    return found[-1]


def grouped(span: str, paths: list[str]) -> list[str]:
    """Commit subjects in the span, under one heading per type, the release commit itself left out."""
    titles = dict(GROUPS)
    buckets: dict[str, list[str]] = {title: [] for title in (*titles.values(), OTHER)}
    for row in git("log", "--format=%h\t%s", span, "--", *paths).splitlines():
        sha, subject = row.split("\t", 1)
        if RELEASE_SUBJECT.match(subject):
            continue
        shape = SUBJECT_TYPE.match(subject)
        buckets[titles.get(shape[1] if shape else "", OTHER)].append(
            f"- {subject} ({sha})"
        )
    lines: list[str] = []
    for title, picked in buckets.items():
        if picked:
            lines += ["", f"### {title}", *picked]
    if len(lines) > MOST_LINES:
        lines = [
            *lines[:MOST_LINES],
            f"- and {len(lines) - MOST_LINES} more lines in git log {span}",
        ]
    return lines


def firmware_notes(version: str, size_bytes: int, sha256: str) -> str:
    at = release_commit(version)
    before = git(
        "log",
        "-1",
        "--format=%H",
        r"-G^set\(PROJECT_VER ",
        f"{at}~1",
        "--",
        "firmware/CMakeLists.txt",
    ).strip()
    span = f"{before}..{at}" if before else at
    why = git("log", "-1", "--format=%b", at).strip()
    lines = [why or f"Firmware {version}.", ""]
    lines.append(
        f"Image on the server: {size_bytes} B, sha256 {sha256}. Not attached here: it holds the fleet's bootstrap token."
    )
    lines += grouped(span, ["firmware"])
    return "\n".join(lines) + "\n"


def models_notes(
    image: Path, lock_path: Path, why: str, min_fw: str, moving: int, since: str
) -> str:
    blob = image.read_bytes()
    version = f"img-{struct.unpack_from('<I', blob, 252)[0]:08x}"
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    recog = lock["recognition"]["sha256"][:16]
    lines = [why, ""]
    lines.append(
        f"Image {version}, {len(blob)} B, recognition model recog-{recog}. Kiosks need firmware {min_fw} or newer."
    )
    if moving:
        lines.append(
            f"It moves {moving} kiosk(s) to another recognition model: each drops every face it holds once it "
            "installs it, and everyone captures again once, at any kiosk (KEHOACH 7.5)."
        )
    lines += ["", "### Branches"]
    for branch in BRANCHES:
        if branch in lock:
            held = lock[branch]
            lines.append(
                f"- {branch}: {held['file']}, sha256 {held['sha256'][:16]}, run {held['run_id']}"
            )
    lines.append(
        "The weights are not attached here: the recognition weights are licensed for research only."
    )
    span = f"{since}..HEAD" if since else "-10"
    rows = git(
        "log", "--format=%h%x09%s%x09%b%x1e", span, "--", "contracts/models.lock.json"
    ).split("\x1e")
    picked = [row.strip("\n").split("\t", 2) for row in rows if row.strip()]
    if picked:
        lines += ["", "### Why the lock changed"]
        for sha, subject, body in picked:
            lines.append(f"- {subject} ({sha})")
            lines += [line for line in body.strip().splitlines() if line.strip()]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    kinds = parser.add_subparsers(dest="kind", required=True)
    fw = kinds.add_parser("firmware", help="notes of a published firmware version")
    fw.add_argument("--version", required=True)
    fw.add_argument(
        "--size", type=int, required=True, help="bytes of the image the server holds"
    )
    fw.add_argument(
        "--sha256", required=True, help="digest of the image the server holds"
    )
    md = kinds.add_parser("models", help="notes of a models image")
    md.add_argument("--image", type=Path, required=True)
    md.add_argument("--lock", type=Path, default=Path("contracts/models.lock.json"))
    md.add_argument("--why", required=True, help="the reason, in English")
    md.add_argument("--min-fw", required=True)
    md.add_argument(
        "--moving",
        type=int,
        default=0,
        help="kiosks it moves to another recognition model",
    )
    md.add_argument(
        "--since", default="", help="the commit of the previous models release, if any"
    )
    args = parser.parse_args(argv)
    if args.kind == "firmware":
        sys.stdout.write(firmware_notes(args.version, args.size, args.sha256))
    else:
        sys.stdout.write(
            models_notes(
                args.image, args.lock, args.why, args.min_fw, args.moving, args.since
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
