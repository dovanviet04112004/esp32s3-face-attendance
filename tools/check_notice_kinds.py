#!/usr/bin/env python3
"""Every notice kind is declared in all six places that name it (KEHOACH 9.21.4).

The Prisma enum, the backend and frontend tables, the frontend's sentence keys,
both catalogues and the lock-screen words each list the kinds. Two `Record`s
catch a table missing a row; nothing else catches a sentence or a word missing.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "backend" / "prisma" / "schema.prisma"
BACKEND_KINDS = ROOT / "backend" / "src" / "modules" / "notifications" / "notice-kinds.ts"
FRONTEND_KINDS = ROOT / "frontend" / "components" / "notifications" / "kinds.ts"
MESSAGES = ROOT / "frontend" / "messages"
SW_WORDS = ROOT / "frontend" / "public" / "sw-words.js"
LOCALES = ("vi", "en")
WORDS_START = "self.SW_WORDS = "

BACKEND_TABLE = "export const NOTICE_KINDS: Record<NoticeKind, KindRule> = {"
FRONTEND_TABLE = "export const NOTICE_LOOK: Record<NoticeKind, KindLook> = {"
ENTRY = re.compile(r"^  ([A-Z][A-Z_]*): \{$", re.MULTILINE)
CATEGORY = re.compile(r'category: "([A-Z_]+)"')


def block(text: str, opening: str, closing: str) -> str:
    """The text between `opening` and the first `closing` after it."""
    start = text.index(opening) + len(opening)
    return text[start : text.index(closing, start)]


def table(text: str, opening: str) -> dict[str, str]:
    """Each kind a table lists, with the category its row names."""
    body = block(text, opening, "\n};")
    heads = list(ENTRY.finditer(body))
    rows: dict[str, str] = {}
    for at, head in enumerate(heads):
        end = heads[at + 1].start() if at + 1 < len(heads) else len(body)
        named = CATEGORY.search(body[head.end() : end])
        rows[head.group(1)] = named.group(1) if named else ""
    return rows


def places(kind: str, found: dict[str, object]) -> list[tuple[str, bool]]:
    """Each place that must name `kind`, and whether it does.

    A kind may split its sentence by a suffix, as `kindREQUEST_DECIDED_true`.
    """
    said = sorted(
        s for s in found["sentences"] if s == f"kind{kind}" or s.startswith(f"kind{kind}_")
    )
    held = [
        ("the NoticeKind enum", kind in found["enum"]),
        ("NOTICE_KINDS in notice-kinds.ts", kind in found["backend"]),
        ("the NoticeKind union in kinds.ts", kind in found["union"]),
        ("NOTICE_LOOK in kinds.ts", kind in found["looks"]),
        (f'NoticeSentence, as "kind{kind}"', bool(said)),
    ]
    for locale in LOCALES:
        catalogue = found["catalogues"][locale]
        held += [(f"notices.{key} in {locale}.json", key in catalogue["notices"]) for key in said]
        held.append((f"push.{kind} in {locale}.json", kind in catalogue["push"]))
        held.append((f"the {locale} words of sw-words.js", kind in found["words"][locale]))
    return held


def main() -> int:
    schema = SCHEMA.read_text(encoding="utf-8")
    front = FRONTEND_KINDS.read_text(encoding="utf-8")
    words = SW_WORDS.read_text(encoding="utf-8")
    found: dict[str, object] = {
        "enum": re.findall(
            r"^\s+([A-Z][A-Z_]*)$", block(schema, "enum NoticeKind {", "\n}"), re.MULTILINE
        ),
        "backend": table(BACKEND_KINDS.read_text(encoding="utf-8"), BACKEND_TABLE),
        "union": re.findall(r'"([A-Z][A-Z_]*)"', block(front, "export type NoticeKind =", ";")),
        "sentences": set(
            re.findall(r'"(kind\w+)"', block(front, "export type NoticeSentence =", ";"))
        ),
        "looks": table(front, FRONTEND_TABLE),
        "catalogues": {
            locale: json.loads((MESSAGES / f"{locale}.json").read_text(encoding="utf-8"))
            for locale in LOCALES
        },
        "words": json.loads(words[words.index(WORDS_START) + len(WORDS_START) : words.rindex(";")]),
    }
    backend, looks = found["backend"], found["looks"]
    kinds = sorted(set(found["enum"]) | set(backend) | set(found["union"]) | set(looks))
    problems: list[str] = []
    for kind in kinds:
        problems += [
            f"{kind}: missing from {name}" for name, held in places(kind, found) if not held
        ]
        if kind in backend and kind in looks and backend[kind] != looks[kind]:
            problems.append(
                f"{kind}: category {backend[kind]} in the backend, {looks[kind]} in the frontend"
            )
    for problem in problems:
        print(problem, file=sys.stderr)
    print(f"check_notice_kinds: {len(kinds)} kind(s), {len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
