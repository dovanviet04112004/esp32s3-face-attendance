#!/usr/bin/env python3
"""Write the lock-screen words of the service worker from the push section of both catalogues.

The worker cannot load the app's catalogues, so it reads this one copy, and no
sentence is typed into the worker by hand (KEHOACH 9.21.4). Run with --check to
fail when the committed file differs from what the catalogues give, as CI does.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MESSAGES = ROOT / "frontend" / "messages"
OUT = ROOT / "frontend" / "public" / "sw-words.js"
LOCALES = ("vi", "en")
SECTION = "push"


def render() -> str:
    """The file's text: the three-line banner, then one object of words per locale."""
    words = {}
    for locale in LOCALES:
        catalogue = json.loads((MESSAGES / f"{locale}.json").read_text(encoding="utf-8"))
        words[locale] = catalogue[SECTION]
    missing = set(words["vi"]) ^ set(words["en"])
    if missing:
        raise SystemExit(f"push words missing from one catalogue: {sorted(missing)}")
    body = json.dumps(words, ensure_ascii=False, indent=2, sort_keys=True)
    return (
        "// GENERATED FILE - DO NOT EDIT.\n"
        "// Source: frontend/messages/{vi,en}.json\n"
        "// Regenerate: ./tools/gen_sw_words.py\n"
        f"self.SW_WORDS = {body};\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="compare with the committed file instead of writing it")
    args = parser.parse_args()
    text = render()
    shown = OUT.relative_to(ROOT)
    if args.check:
        held = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if held != text:
            print(f"{shown} is out of date with the catalogues; run ./tools/gen_sw_words.py", file=sys.stderr)
            return 1
        print(f"gen_sw_words: {shown} matches the catalogues")
        return 0
    OUT.write_text(text, encoding="utf-8")
    print(f"gen_sw_words: wrote {shown}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
