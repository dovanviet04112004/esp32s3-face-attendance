#!/usr/bin/env python3
"""Every api error code needs a sentence in both catalogues (CLAUDE.md 3.1).

The type-level guard in `i18n/request.ts` catches vi.json drifting from
en.json. It cannot see a code the backend throws that neither file answers,
nor a throw carrying a sentence, which no catalogue can answer at all.
Exit code is 1 when one is missing.
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

HTTP = r"(?:BadRequest|NotFound|Conflict|Forbidden|Unauthorized|Gone|UnprocessableEntity|Throttler)"
# The argument list runs to the end of the line, which is where every one of
# these calls ends; a ternary between two codes is still one call.
CALL = re.compile(HTTP + r"Exception\(([^\n]*)")
LITERAL = re.compile(r"\"([^\"]*)\"|`([^`]*)`")
CODE = re.compile(r"^[A-Z0-9_]+$")
# The throttler answers with the code its module options name, not a throw.
OPTION = re.compile(r"errorMessage:\s*\"([A-Z0-9_]+)\"")

# Raised by the frontend itself when no response arrives, so no backend file
# mentions it.
CLIENT_ONLY = {"NETWORK_UNREACHABLE"}


def codes_in(argument: str) -> tuple[list[str], list[str]]:
    """The codes a call throws, and the wording it throws instead of one."""
    codes: list[str] = []
    prose: list[str] = []
    for quoted, templated in LITERAL.findall(argument):
        if templated:
            prose.append(f"`{templated}`")
        elif CODE.match(quoted):
            codes.append(quoted)
        else:
            prose.append(f'"{quoted}"')
    return codes, prose


def scan() -> tuple[dict[str, list[str]], list[str]]:
    found: dict[str, list[str]] = {}
    sentences: list[str] = []
    for path in sorted(BACKEND.rglob("*.ts")):
        for at, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for code in OPTION.findall(line):
                found.setdefault(code, []).append(str(path))
            for argument in CALL.findall(line):
                codes, prose = codes_in(argument)
                for code in codes:
                    found.setdefault(code, []).append(str(path))
                for said in prose:
                    sentences.append(f"{path}:{at}: throws {said}, not a code")
                if not codes and not prose:
                    sentences.append(f"{path}:{at}: throws no code at all")
    return found, sentences


def main() -> int:
    codes, sentences = scan()
    problems: list[str] = list(sentences)
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
