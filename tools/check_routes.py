#!/usr/bin/env python3
"""Every route carries @Roles or takes @CurrentViewer, and every desk route @Reach (KEHOACH 9.4).

One without either knows neither who is asking nor who to refuse, so it hands
a whole table to any account that can log in. OPEN lists the ones that are
meant for everybody, with the reason each is there. A route HR or PAYROLL may
call says how it narrows for a desk held to some entities.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

CONTROLLERS = Path("backend/src/modules")

# Routes that answer the same to everybody, and why nothing narrows them.
OPEN: dict[str, str] = {
    "POST /auth/login": "there is no viewer yet",
    "POST /auth/mfa/verify": "the ticket a right password earned is the caller (KEHOACH 9.4)",
    "POST /auth/mfa/setup": "the ticket a right password earned is the caller (KEHOACH 9.4)",
    "POST /auth/mfa/confirm": "the ticket a right password earned is the caller (KEHOACH 9.4)",
    "POST /auth/set-password": "a link, not a session",
    "POST /auth/forgot-password": "an address is all it is offered (KEHOACH 9.4)",
    "POST /auth/not-me": "the link in a new-password mail is the caller (KEHOACH 9.4)",
    "POST /auth/refresh": "the cookie is the caller",
    "POST /auth/logout": "ends whatever session presented itself",
    "GET /auth/me": "reads the caller's own claims off the request",
    "POST /devices/register": "a kiosk, not a person (KEHOACH 7.3)",
    "GET /devices/me": "a kiosk proving its own ticket, held by the device guard (KEHOACH 7.3)",
    "POST /devices/me/token": (
        "a kiosk trading its own ticket, held by the device guard (KEHOACH 7.3)"
    ),
    "POST /mqtt/auth": (
        "the broker asks about a kiosk; traefik keeps it off the internet (KEHOACH 7.4)"
    ),
    "GET /leave-types": "the filing form needs them and they name no person",
    "GET /health": "the deploy script asks with no account, and it names no row (KEHOACH 4.8)",
    "POST /releases": "CI or the training box, held by the publisher token guard (KEHOACH 7.7)",
    "GET /releases/:releaseId/image": "a kiosk holding a link signed for it alone (KEHOACH 7.7)",
    "GET /releases/published": (
        "CI asking before it builds, held by the publisher token guard (KEHOACH 7.7)"
    ),
    "PUT /releases/details": (
        "the release box describing a release, held by the publisher token guard (KEHOACH 7.7)"
    ),
}

VERBS = re.compile(r'^\s*@(Get|Post|Patch|Put|Delete)\(\s*"?([^"),]*)"?')
ROLES = re.compile(r"@Roles\(([^)]*)\)")
REACH = re.compile(r"@Reach\(")
# The desk roles, by name or through a role list a route spreads.
DESK = re.compile(r'"HR"|"PAYROLL"|IMPORT_ROLES|QUEUE_DESKS')
SIGNATURE_END = re.compile(r"\)\s*:")


def routes(path: Path) -> list[tuple[str, bool, bool]]:
    """Per route: its name, whether it knows who asks, and whether it lacks a needed @Reach."""
    text = path.read_text(encoding="utf-8")
    head = text.split("export class", 1)[0]
    class_roles = ROLES.search(head)
    class_reach = bool(REACH.search(head))
    base = re.search(r'@Controller\(\s*"?([^"),]*)"?', text)
    prefix = (base.group(1) if base else "").strip("/")
    lines = text.splitlines()
    found: list[tuple[str, bool, bool]] = []

    for i, line in enumerate(lines):
        verb = VERBS.match(line)
        if not verb:
            continue
        tail = (verb.group(2) or "").strip("/")
        name = f"/{prefix}/{tail}".replace("//", "/").rstrip("/") or "/"
        roles = class_roles.group(1) if class_roles else None
        reach = class_reach
        sees = False
        for j in range(i + 1, len(lines)):
            own = ROLES.search(lines[j])
            if own:
                roles = own.group(1)
            if REACH.search(lines[j]):
                reach = True
            if "CurrentViewer" in lines[j]:
                sees = True
            if SIGNATURE_END.search(lines[j]):
                break
            if VERBS.match(lines[j]):
                break
        desk = roles is not None and bool(DESK.search(roles))
        found.append(
            (f"{verb.group(1).upper()} {name}", roles is not None or sees, desk and not reach)
        )
    return found


def main() -> int:
    if not CONTROLLERS.is_dir():
        print(f"check_routes: no {CONTROLLERS}", file=sys.stderr)
        return 2

    faults = 0
    counted = 0
    claimed = set()
    for path in sorted(CONTROLLERS.rglob("*.controller.ts")):
        for name, guarded, unreached in routes(path):
            counted += 1
            if unreached:
                print(f"{path}: {name} is a desk route without @Reach")
                faults += 1
            if name in OPEN:
                claimed.add(name)
                continue
            if guarded:
                continue
            print(f"{path}: {name} has neither @Roles nor @CurrentViewer")
            faults += 1

    # A stale OPEN entry would exempt whatever route takes that name next.
    for name in sorted(set(OPEN) - claimed):
        print(f"OPEN lists {name}, which no controller declares")
        faults += 1

    print(f"check_routes: {counted} route(s), {faults} problem(s)")
    return 1 if faults else 0


if __name__ == "__main__":
    sys.exit(main())
