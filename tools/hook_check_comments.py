#!/usr/bin/env python3
"""Reject a Write or Edit whose file breaks the comment rules of CLAUDE.md section 2.

Reads the PostToolUse payload on stdin and exits 2 so the report reaches the model
as blocking feedback. Files the checker does not scan pass straight through.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CHECKER = REPO_ROOT / "tools" / "check_comments.py"
SUFFIXES = {
    ".py",
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".hpp",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".yaml",
    ".yml",
}


def edited_path(payload: dict) -> Path | None:
    response = payload.get("tool_response")
    named = response.get("filePath") if isinstance(response, dict) else None
    named = named or payload.get("tool_input", {}).get("file_path")
    return Path(named) if named else None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0
    path = edited_path(payload)
    if path is None or path.suffix not in SUFFIXES or not path.is_file():
        return 0
    if REPO_ROOT not in path.resolve().parents:
        return 0
    done = subprocess.run(
        [sys.executable, str(CHECKER), str(path)], capture_output=True, text=True
    )
    if done.returncode == 0:
        return 0
    print(done.stdout.strip(), file=sys.stderr)
    print(
        "CLAUDE.md section 2: fix these before continuing. Rationale belongs in the "
        "commit message, plan sections are cited not copied, and measurements go to "
        "docs/measurements/. The `comments` skill has the procedure.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
