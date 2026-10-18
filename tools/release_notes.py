#!/usr/bin/env python3
"""Write the notes of a firmware or models release and the GitHub page carrying them (KEHOACH 7.7).

The publisher writes the notes for the people who run kiosks, in Vietnamese and in English, in an
editor that lists the commits since the previous release as hints. Commits are written for people
reading code, so they reach GitHub only as a compare link; tools/check_commit_msg.py keeps the hints
readable.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

CMAKE = "firmware/CMakeLists.txt"
LOCK = "contracts/models.lock.json"
DTO = Path("backend/src/modules/models/dto/release.dto.ts")
SECTION = re.compile(r"^\[(vi|en)\]\s*$")
EMPTY_BULLET = re.compile(r"^-\s*$")
RELEASE_SUBJECT = re.compile(r"^build\(firmware\): release ")
LANGUAGES = (("vi", "notesVi"), ("en", "notesEn"))
MOST_HINTS = 60
BRANCHES = ("detection", "antispoof", "recognition")


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def notes_max_len() -> int:
    """The longest notes the server takes, read from its DTO so the number lives once."""
    found = re.search(r"NOTES_MAX_LEN = (\d+)", DTO.read_text(encoding="utf-8"))
    if not found:
        sys.exit(f"NOTES_MAX_LEN is gone from {DTO}")
    return int(found[1])


def firmware_span(version: str) -> tuple[str, str]:
    """The previous release commit, and the one that set this version (HEAD until committed)."""
    found = git("log", "--format=%H", f'-Sset(PROJECT_VER "{version}")', "--", CMAKE).split()
    at = found[-1] if found else "HEAD"
    before = git(
        "log",
        "-1",
        "--format=%H",
        r"-G^set\(PROJECT_VER ",
        f"{at}~1" if found else "HEAD",
        "--",
        CMAKE,
    ).strip()
    return before, at


def hints(span: str, paths: list[str]) -> list[str]:
    rows = git("log", "--format=%h\t%s", span, "--", *paths).splitlines()
    picked = [
        f"{subject} ({sha})"
        for sha, subject in (row.split("\t", 1) for row in rows)
        if not RELEASE_SUBJECT.match(subject)
    ]
    if len(picked) > MOST_HINTS:
        return [
            *picked[:MOST_HINTS],
            f"... and {len(picked) - MOST_HINTS} more: git log {span}",
        ]
    return picked


def template(title: str, commits: list[str], current: dict[str, str | None]) -> str:
    lines = [
        f"# What's new in {title}, as kiosk owners read it on the dashboard and on GitHub.",
        '# A few "- " lines per language: what is new, what got faster, what stopped going wrong.',
        "# No file names, commit types or code. Lines starting with # are dropped.",
    ]
    if commits:
        lines += [
            "#",
            "# Commits since the previous release, hints only:",
            *(f"#   {one}" for one in commits),
        ]
    for lang, key in LANGUAGES:
        lines += ["", f"[{lang}]", current.get(key) or "- "]
    return "\n".join(lines) + "\n"


def parse(text: str, most: int) -> dict[str, str]:
    """The notes under [vi] and [en], or ValueError naming what is missing."""
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if line.lstrip().startswith("#"):
            continue
        head = SECTION.match(line)
        if head:
            current = head[1]
            sections[current] = []
        elif current:
            if not EMPTY_BULLET.match(line):
                sections[current].append(line)
        elif line.strip():
            raise ValueError("write the notes under [vi] and [en]")
    notes: dict[str, str] = {}
    for lang, key in LANGUAGES:
        body = "\n".join(sections.get(lang, [])).strip()
        if not body:
            raise ValueError(f"the [{lang}] notes are empty")
        if len(body) > most:
            raise ValueError(f"the [{lang}] notes run {len(body)} characters, over {most}")
        notes[key] = body
    return notes


def edit(draft: Path) -> None:
    if not sys.stdin.isatty():
        sys.exit(
            f"no terminal for an editor: write {draft} with [vi] and [en] and pass NOTES={draft}"
        )
    editor = (
        os.environ.get("VISUAL")
        or os.environ.get("EDITOR")
        or ("nano" if shutil.which("nano") else "vi")
    )
    subprocess.run([*shlex.split(editor), str(draft)], check=True)


def write(args: argparse.Namespace) -> int:
    if not args.draft.exists():
        if args.no_edit:
            sys.exit(f"no {args.draft}")
        held = args.current.read_text(encoding="utf-8").strip() if args.current else ""
        if args.kind == "firmware":
            before, at = firmware_span(args.version)
            commits = hints(f"{before}..{at}" if before else at, ["firmware"])
            title = f"Firmware {args.version}"
        else:
            commits = hints(f"{args.since}..HEAD" if args.since else "-10", [LOCK])
            title = f"Models {args.version}"
        args.draft.parent.mkdir(parents=True, exist_ok=True)
        args.draft.write_text(
            template(title, commits, json.loads(held) if held else {}),
            encoding="utf-8",
        )
    most = notes_max_len()
    while True:
        if not args.no_edit:
            edit(args.draft)
        try:
            notes = parse(args.draft.read_text(encoding="utf-8"), most)
        except ValueError as fault:
            if args.no_edit:
                sys.exit(f"{args.draft}: {fault}")
            print(f"{args.draft}: {fault}")
            if input("Edit again? [Y/n] ").strip().lower() == "n":
                return 1
            continue
        if args.out:
            args.out.write_text(json.dumps(notes, ensure_ascii=False), encoding="utf-8")
        print(f"notes kept in {args.draft}")
        return 0


def firmware_facts(args: argparse.Namespace) -> tuple[list[str], str]:
    before, at = firmware_span(args.version)
    facts = [
        f"Image on the server: {args.size} B, sha256 `{args.sha256}`. "
        "Not attached: it carries the fleet's bootstrap token."
    ]
    if args.requires:
        facts.append(f"Kiosks install models {args.requires} or newer before this firmware.")
    link = f"{args.repo}/compare/{before}...{at}" if before else f"{args.repo}/commits/{at}"
    return facts, link


def models_facts(args: argparse.Namespace) -> tuple[list[str], str]:
    blob = args.image.read_bytes()
    lock = json.loads(args.lock.read_text(encoding="utf-8"))
    facts = [
        f"Image {args.version}, {len(blob)} B, "
        f"recognition model recog-{lock['recognition']['sha256'][:16]}. "
        f"Kiosks need firmware {args.min_fw} or newer."
    ]
    if args.moving:
        facts.append(
            f"It moves {args.moving} kiosk(s) to another recognition model: "
            "each drops every face it holds once it "
            "installs it, and everyone captures again once, at any kiosk (KEHOACH 7.5)."
        )
    facts += [
        f"- {branch}: {lock[branch]['file']}, "
        f"sha256 {lock[branch]['sha256'][:16]}, run {lock[branch]['run_id']}"
        for branch in BRANCHES
        if branch in lock
    ]
    facts.append(
        "The weights are not attached: the recognition weights are licensed for research only."
    )
    link = (
        f"{args.repo}/compare/{args.since}...{args.at}"
        if args.since
        else f"{args.repo}/commits/{args.at}/{LOCK}"
    )
    return facts, link


def github(args: argparse.Namespace) -> int:
    notes = json.loads(args.notes.read_text(encoding="utf-8"))
    facts, link = (firmware_facts if args.kind == "firmware" else models_facts)(args)
    lines = [
        "## Có gì mới",
        "",
        notes["notesVi"],
        "",
        "## What's new",
        "",
        notes["notesEn"],
        "",
        "---",
        "",
        *facts,
        "",
        f"Commits: {link}",
    ]
    sys.stdout.write("\n".join(lines) + "\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    steps = parser.add_subparsers(dest="step", required=True)
    wr = steps.add_parser(
        "write", help="open the notes in an editor and check them, or check NOTES alone"
    )
    wr.add_argument("kind", choices=("firmware", "models"))
    wr.add_argument("--version", required=True)
    wr.add_argument(
        "--draft",
        type=Path,
        required=True,
        help="the notes as [vi] and [en] sections, kept between runs",
    )
    wr.add_argument("--out", type=Path, help="where the checked notes go as JSON")
    wr.add_argument(
        "--current", type=Path, help="JSON of the notes the server holds, to start from"
    )
    wr.add_argument("--since", default="", help="the commit of the previous models release, if any")
    wr.add_argument("--no-edit", action="store_true", help="check the draft as it is")
    gh = steps.add_parser("github", help="the body of the GitHub release")
    gh.add_argument("kind", choices=("firmware", "models"))
    gh.add_argument("--version", required=True)
    gh.add_argument("--notes", type=Path, required=True, help="the JSON write left")
    gh.add_argument("--repo", required=True, help="https://github.com/<owner>/<repo>")
    gh.add_argument("--size", type=int, help="bytes of the firmware image the server holds")
    gh.add_argument("--sha256", help="digest of the firmware image the server holds")
    gh.add_argument("--requires", default="", help="the models the firmware needs first")
    gh.add_argument("--image", type=Path)
    gh.add_argument("--lock", type=Path, default=Path(LOCK))
    gh.add_argument("--min-fw", default="")
    gh.add_argument(
        "--moving", type=int, default=0, help="kiosks it moves to another recognition model"
    )
    gh.add_argument("--since", default="", help="the commit of the previous models release")
    gh.add_argument("--at", default="", help="the commit the models release points at")
    args = parser.parse_args(argv)
    return write(args) if args.step == "write" else github(args)


if __name__ == "__main__":
    raise SystemExit(main())
