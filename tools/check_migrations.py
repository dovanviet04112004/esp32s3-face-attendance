#!/usr/bin/env python3
"""Enforce expand-then-contract on Prisma migrations (KEHOACH 9.22.3c).

A destructive statement passes only when the comment above it says which
migration moved the data first. Run with no arguments to scan every migration,
or pass paths to scan a subset. Exit code is 1 when any rule is violated.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

MIGRATIONS = Path("backend/prisma/migrations")

# Each rule is a statement that destroys something and the note that excuses it.
RULES: list[tuple[str, re.Pattern[str], re.Pattern[str] | None]] = [
    ("DROP TABLE", re.compile(r"^\s*DROP\s+TABLE\b", re.I), re.compile(r"contract of\s+\S+", re.I)),
    (
        "DROP COLUMN",
        re.compile(r"\bDROP\s+COLUMN\b", re.I),
        re.compile(r"contract of\s+\S+", re.I),
    ),
    (
        "ALTER COLUMN ... TYPE",
        re.compile(r"\bALTER\s+COLUMN\b.*\bTYPE\b", re.I),
        re.compile(r"\bwidening\b", re.I),
    ),
    (
        "SET NOT NULL",
        re.compile(r"\bSET\s+NOT\s+NULL\b", re.I),
        re.compile(r"backfilled by\s+\S+", re.I),
    ),
    (
        "DROP CONSTRAINT",
        re.compile(r"\bDROP\s+CONSTRAINT\b", re.I),
        re.compile(r"replaced by\s+\S+", re.I),
    ),
    ("TRUNCATE", re.compile(r"^\s*TRUNCATE\b", re.I), None),
]

COMMENT = re.compile(r"^\s*--\s?(.*)$")

# Applied everywhere and older than this rule; editing one breaks the checksum
# Prisma keeps, so they are named rather than rewritten or skipped quietly.
GRANDFATHERED = {
    "20260919165510_attendance_flags": "dropped AttendanceRecord.synced in the release that replaced it",
    "20260920000000_hr_foundation": "dropped Employee.department in the release that moved it to Department",
}


def notes_above(lines: list[str], at: int) -> str:
    """Every comment line directly above a statement, joined."""
    held: list[str] = []
    walk = at - 1
    while walk >= 0:
        found = COMMENT.match(lines[walk])
        if not found:
            break
        held.append(found.group(1))
        walk -= 1
    return " ".join(reversed(held))


def scan(path: Path) -> list[str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    problems: list[str] = []
    for at, line in enumerate(lines):
        if COMMENT.match(line):
            continue
        for name, statement, excuse in RULES:
            if not statement.search(line):
                continue
            if excuse is None:
                problems.append(f"{path}:{at + 1}: {name} is never allowed")
                continue
            if not excuse.search(notes_above(lines, at)):
                problems.append(
                    f"{path}:{at + 1}: {name} needs a note above it matching"
                    f" /{excuse.pattern}/ (KEHOACH 9.22.3c)"
                )
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", type=Path)
    chosen = parser.parse_args().paths or sorted(MIGRATIONS.rglob("migration.sql"))

    problems: list[str] = []
    for path in chosen:
        if path.suffix != ".sql" or not path.exists():
            continue
        if path.parent.name in GRANDFATHERED:
            continue
        problems.extend(scan(path))

    for problem in problems:
        print(problem)
    print(f"check_migrations: {len(chosen)} file(s), {len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
