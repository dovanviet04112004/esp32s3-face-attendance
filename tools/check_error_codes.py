#!/usr/bin/env python3
"""Every api error code needs a sentence in both catalogues (CLAUDE.md 3.1).

The type-level guard in `i18n/request.ts` catches vi.json drifting from
en.json. It cannot see a code the backend throws that neither file answers,
because nothing in the frontend names that key. Exit code is 1 when one is
missing.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

BACKEND = Path("backend/src")
CATALOGUES = {
    "vi": Path("frontend/messages/vi.json"),
    "en": Path("frontend/messages/en.json"),
}

THROWN = re.compile(
    r"(?:BadRequest|NotFound|Conflict|Forbidden|Unauthorized|Gone|"
    r"UnprocessableEntity)Exception\(\s*\"([A-Z0-9_]+)\""
)

# Raised by the frontend itself when no response arrives, so no backend file
# mentions it.
CLIENT_ONLY = {"NETWORK_UNREACHABLE"}


def thrown_codes() -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for path in sorted(BACKEND.rglob("*.ts")):
        for code in THROWN.findall(path.read_text(encoding="utf-8")):
            found.setdefault(code, []).append(str(path))
    return found


def main() -> int:
    codes = thrown_codes()
    problems: list[str] = []
    for language, path in CATALOGUES.items():
        if not path.exists():
            print(f"{path}: missing")
            return 1
        known = set(json.loads(path.read_text(encoding="utf-8")).get("errors", {}))
        for code in sorted(set(codes) - known):
            problems.append(f"{codes[code][0]}: {code} has no {language} sentence")
        for code in sorted(known - set(codes) - CLIENT_ONLY):
            problems.append(f"{path}: {code} answers a code nothing throws")

    for problem in problems:
        print(problem)
    print(f"check_error_codes: {len(codes)} code(s), {len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
