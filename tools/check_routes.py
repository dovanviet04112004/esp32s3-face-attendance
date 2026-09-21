#!/usr/bin/env python3
"""Every route carries @Roles or takes @CurrentViewer (KEHOACH 9.4).

One without either knows neither who is asking nor who to refuse, so it hands
a whole table to any account that can log in. OPEN lists the ones that are
meant for everybody, with the reason each is there.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

CONTROLLERS = Path("backend/src/modules")

# Routes that answer the same to everybody, and why nothing narrows them.
OPEN: dict[str, str] = {
    "POST /auth/login": "there is no viewer yet",
    "POST /auth/set-password": "a link, not a session",
    "POST /auth/forgot-password": "an address is all it is offered (KEHOACH 9.4)",
    "POST /auth/refresh": "the cookie is the caller",
    "POST /auth/logout": "ends whatever session presented itself",
    "GET /auth/me": "reads the caller's own claims off the request",
    "POST /devices/register": "a kiosk, not a person (KEHOACH 7.3)",
    "GET /leave-types": "the filing form needs them and they name no person",
}

VERBS = re.compile(r'^\s*@(Get|Post|Patch|Put|Delete)\(\s*"?([^"),]*)"?')
ROLES = re.compile(r"@Roles\(")
SIGNATURE_END = re.compile(r"\)\s*:")


def routes(path: Path) -> list[tuple[str, bool]]:
    text = path.read_text(encoding="utf-8")
    head = text.split("export class", 1)[0]
    guarded_class = bool(ROLES.search(head))
    base = re.search(r'@Controller\(\s*"?([^"),]*)"?', text)
    prefix = (base.group(1) if base else "").strip("/")
    lines = text.splitlines()
    found: list[tuple[str, bool]] = []

    for i, line in enumerate(lines):
        verb = VERBS.match(line)
        if not verb:
            continue
        tail = (verb.group(2) or "").strip("/")
        name = f"/{prefix}/{tail}".replace("//", "/").rstrip("/") or "/"
        guarded = guarded_class
        sees = False
        for j in range(i + 1, len(lines)):
            if ROLES.search(lines[j]):
                guarded = True
            if "CurrentViewer" in lines[j]:
                sees = True
            if SIGNATURE_END.search(lines[j]):
                break
            if VERBS.match(lines[j]):
                break
        found.append((f"{verb.group(1).upper()} {name}", guarded or sees))
    return found


def main() -> int:
    if not CONTROLLERS.is_dir():
        print(f"check_routes: no {CONTROLLERS}", file=sys.stderr)
        return 2

    faults = 0
    counted = 0
    claimed = set()
    for path in sorted(CONTROLLERS.rglob("*.controller.ts")):
        for name, guarded in routes(path):
            counted += 1
            if name in OPEN:
                claimed.add(name)
                continue
            if guarded:
                continue
            print(f"{path}: {name} has neither @Roles nor @CurrentViewer")
            faults += 1

    # An exemption naming a route nobody declares would cover whatever takes
    # that name next, so a stale entry is a fault of its own.
    for name in sorted(set(OPEN) - claimed):
        print(f"OPEN lists {name}, which no controller declares")
        faults += 1

    print(f"check_routes: {counted} route(s), {faults} problem(s)")
    return 1 if faults else 0


if __name__ == "__main__":
    sys.exit(main())
