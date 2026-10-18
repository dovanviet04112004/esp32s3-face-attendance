#!/usr/bin/env python3
"""Check commit messages against CLAUDE.md 5, since release notes are built from them (KEHOACH 7.7).

As the commit-msg hook it reads the message file git hands it; with --range A..B it reads
every commit in that range, the way a CI step would. A message git writes itself, a merge,
a revert or a fixup, passes untouched.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

TYPES = ("feat", "fix", "refactor", "perf", "test", "docs", "build", "ci", "chore")
HEADER = re.compile(
    r"^(?P<type>[a-z]+)(?:\((?P<scope>[a-z0-9_./-]+)\))?(?P<bang>!)?: (?P<subject>.+)$"
)
BANNED_SUBJECTS = {"update code", "fix", "final", "test again", "new version", "wip"}
PAST_TENSE = re.compile(r"^(added|fixed|updated|changed|removed|updating|adding|fixing)\b")
GIT_WRITTEN = re.compile(r"^(Merge |Revert \"|fixup! |squash! |amend! )")
VIETNAMESE = re.compile(
    "[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ"
    "ÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]"
)
AI_TRAILER = re.compile(
    r"^(co-authored-by:.*\b(claude|anthropic|openai|gpt|copilot|gemini)\b|.*generated with \[?claude)",
    re.IGNORECASE,
)
SCISSORS = "# ------------------------ >8 ------------------------"


def message_lines(text: str) -> list[str]:
    """The lines git keeps: comments and everything under the scissors line go."""
    kept = []
    for line in text.splitlines():
        if line.startswith(SCISSORS):
            break
        if not line.startswith("#"):
            kept.append(line.rstrip())
    while kept and not kept[-1]:
        kept.pop()
    return kept


def problems(text: str) -> list[str]:
    """Every rule of CLAUDE.md 5 and 3.1 the message breaks, empty when it is fine."""
    lines = message_lines(text)
    if not lines or not lines[0]:
        return ["the message is empty"]
    header = lines[0]
    if GIT_WRITTEN.match(header):
        return []
    found = []
    shape = HEADER.match(header)
    if not shape:
        found.append(f"the first line is not '<type>(<scope>): <description>': {header}")
    else:
        subject = shape["subject"]
        if shape["type"] not in TYPES:
            found.append(f"type '{shape['type']}' is none of {', '.join(TYPES)}")
        if subject[0].isupper():
            found.append("the description must start with a lowercase letter")
        if subject.endswith("."):
            found.append("the description must not end with a full stop")
        if subject.lower() in BANNED_SUBJECTS:
            found.append(f"'{subject}' says nothing about the change")
        if PAST_TENSE.match(subject.lower()):
            found.append(
                "the description must be imperative: add, fix, remove, not added or fixing"
            )
        if shape["bang"] and not any(line.startswith("BREAKING CHANGE:") for line in lines):
            found.append("a '!' after the scope needs a 'BREAKING CHANGE:' footer")
    if len(lines) > 1 and lines[1]:
        found.append("a blank line must separate the first line from the body")
    if any(VIETNAMESE.search(line) for line in lines):
        found.append("commit messages are English only (CLAUDE.md 3.1)")
    if any(AI_TRAILER.match(line) for line in lines):
        found.append("no AI agent in any trailer (CLAUDE.md 5.6)")
    return found


def commits_in(span: str) -> list[tuple[str, str]]:
    """The short hash and the message of every commit in a git range, oldest first."""
    hashes = subprocess.run(
        ["git", "rev-list", "--reverse", "--no-merges", span],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split()
    return [
        (
            sha[:8],
            subprocess.run(
                ["git", "show", "-s", "--format=%B", sha],
                check=True,
                capture_output=True,
                text=True,
            ).stdout,
        )
        for sha in hashes
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "message_file", nargs="?", type=Path, help="the file the commit-msg hook gets"
    )
    parser.add_argument("--range", dest="span", help="check every commit in A..B instead")
    args = parser.parse_args(argv)
    if (args.message_file is None) == (args.span is None):
        parser.error("give a message file or --range, one of the two")
    named = (
        commits_in(args.span)
        if args.span
        else [("message", args.message_file.read_text(encoding="utf-8"))]
    )
    failed = 0
    for name, text in named:
        for problem in problems(text):
            print(f"{name}: {problem}", file=sys.stderr)
            failed += 1
    if failed:
        print(
            "commit format: CLAUDE.md 5, e.g. 'fix(firmware/drv_lcd): retry a scanline read' + a body",
            file=sys.stderr,
        )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
