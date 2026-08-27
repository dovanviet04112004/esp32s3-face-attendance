#!/usr/bin/env python3
"""Enforce the comment rules of CLAUDE.md sections 2.3, 2.4 and 2.6.

Run with no arguments to scan the whole repo, or pass paths to scan a subset.
Exit code is 1 when any rule is violated.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

SKIP_DIR_PARTS = {
    ".git",
    "build",
    "node_modules",
    "managed_components",
    "third_party",
    "generated",
    "__pycache__",
    ".venv",
    ".next",
    "dist",
    "artifacts",
    "cache",
}

C_HEADER_SUFFIXES = {".h", ".hpp"}
C_BODY_SUFFIXES = {".c", ".cpp", ".cc"}
PY_SUFFIXES = {".py"}
TS_SUFFIXES = {".ts", ".tsx", ".js", ".jsx"}
SCANNED_SUFFIXES = C_HEADER_SUFFIXES | C_BODY_SUFFIXES | PY_SUFFIXES | TS_SUFFIXES

MAX_CONSECUTIVE_BODY_COMMENTS = 2
MAX_DOC_COMMENT_LINES = 6
MAX_TRAILING_COMMENT_CHARS = 60
MAX_COMMENT_DENSITY = 0.10

PROCESS_WORDS = [
    "previously",
    "used to",
    "was",
    "were",
    "before",
    "originally",
    "changed",
    "updated",
    "fixed",
    "refactored",
    "instead of",
    "now we",
    "no longer",
    "note that i",
    "trước đây",
    "đã sửa",
    "thay vì",
]
PROCESS_RE = re.compile(
    r"(?<![\w])(" + "|".join(re.escape(w) for w in PROCESS_WORDS) + r")(?![\w])",
    re.IGNORECASE,
)

BANNER_RE = re.compile(r"^\s*(//|#)\s*[=*\-#~_+]{4,}")
STAR_BANNER_RE = re.compile(r"/\*{3,}")
END_OF_RE = re.compile(r"^\s*(//|#)\s*end of\b", re.IGNORECASE)
CODE_LIKE_RE = re.compile(
    r"^\s*(//|#)\s*"
    r"("
    r".*;\s*$"
    r"|.*\{\s*$"
    r"|\}\s*;?\s*$"
    r"|(if|for|while|switch|return|import|from|def|class|const|let|var|#include)\b.*"
    r")"
)
GENERATED_FIRST_LINE = "// GENERATED FILE - DO NOT EDIT."


@dataclass
class Problem:
    path: Path
    line: int
    rule: str
    detail: str

    def render(self, root: Path) -> str:
        try:
            shown: Path | str = self.path.relative_to(root)
        except ValueError:
            shown = self.path
        return f"{shown}:{self.line}: [{self.rule}] {self.detail}"


def iter_source_files(targets: list[Path]) -> list[Path]:
    files: list[Path] = []
    for target in targets:
        if target.is_file():
            if target.suffix in SCANNED_SUFFIXES:
                files.append(target)
            continue
        for path in sorted(target.rglob("*")):
            if path.suffix not in SCANNED_SUFFIXES or not path.is_file():
                continue
            if SKIP_DIR_PARTS.intersection(path.parts):
                continue
            files.append(path)
    return files


def strip_string_literals(line: str) -> str:
    return re.sub(r"(\"(\\.|[^\"\\])*\"|'(\\.|[^'\\])*')", '""', line)


def find_line_comment(line: str, markers: tuple[str, ...]) -> tuple[int, str] | None:
    masked = strip_string_literals(line)
    for marker in markers:
        idx = masked.find(marker)
        if idx != -1:
            return idx, line[idx:].rstrip()
    return None


def is_generated(lines: list[str]) -> bool:
    return bool(lines) and lines[0].strip() == GENERATED_FIRST_LINE


def check_generated_banner(path: Path, lines: list[str]) -> list[Problem]:
    if len(lines) < 3:
        return [Problem(path, 1, "2.9", "generated file needs the three-line banner")]
    problems = []
    if not lines[1].strip().startswith("// Source:"):
        problems.append(Problem(path, 2, "2.9", "second banner line must be '// Source: ...'"))
    if not lines[2].strip().startswith("// Regenerate:"):
        problems.append(Problem(path, 3, "2.9", "third banner line must be '// Regenerate: ...'"))
    return problems


def check_common(path: Path, comments: list[tuple[int, str]]) -> list[Problem]:
    problems = []
    for lineno, text in comments:
        hit = PROCESS_RE.search(text)
        if hit:
            problems.append(
                Problem(path, lineno, "2.4", f"process comment, drop the word {hit.group(1)!r}")
            )
        if BANNER_RE.match(text) or STAR_BANNER_RE.search(text):
            problems.append(Problem(path, lineno, "2.6", "banner or ASCII art comment"))
        if END_OF_RE.match(text):
            problems.append(Problem(path, lineno, "2.6", "'end of ...' comment"))
        if CODE_LIKE_RE.match(text):
            problems.append(Problem(path, lineno, "2.6", "commented-out code, delete it"))
    return problems


def check_runs_and_density(
    path: Path, lines: list[str], comment_lines: set[int], is_header: bool
) -> list[Problem]:
    problems = []
    if not is_header:
        run_start = None
        run_len = 0
        for lineno in range(1, len(lines) + 1):
            if lineno in comment_lines and not lines[lineno - 1].strip().startswith(("//", "#")):
                continue
            if lineno in comment_lines:
                run_start = run_start or lineno
                run_len += 1
            else:
                if run_len > MAX_CONSECUTIVE_BODY_COMMENTS:
                    problems.append(
                        Problem(
                            path,
                            run_start,
                            "2.3",
                            f"{run_len} consecutive comment lines, limit is "
                            f"{MAX_CONSECUTIVE_BODY_COMMENTS}",
                        )
                    )
                run_start = None
                run_len = 0
        if run_len > MAX_CONSECUTIVE_BODY_COMMENTS:
            problems.append(
                Problem(path, run_start, "2.3", f"{run_len} consecutive comment lines")
            )

        code_lines = [i for i, ln in enumerate(lines, 1) if ln.strip()]
        if len(code_lines) >= 20:
            density = len(comment_lines) / len(code_lines)
            if density > MAX_COMMENT_DENSITY:
                problems.append(
                    Problem(
                        path,
                        1,
                        "2.3",
                        f"comment density {density:.0%} exceeds {MAX_COMMENT_DENSITY:.0%}",
                    )
                )
    return problems


def check_c_like(path: Path, lines: list[str], is_header: bool) -> list[Problem]:
    problems: list[Problem] = []
    comments: list[tuple[int, str]] = []
    comment_lines: set[int] = set()

    in_block = False
    block_start = 0
    block_len = 0
    block_is_doc = False

    for lineno, raw in enumerate(lines, 1):
        line = raw.rstrip("\n")
        if in_block:
            comments.append((lineno, line))
            comment_lines.add(lineno)
            block_len += 1
            if "*/" in line:
                in_block = False
                if block_is_doc and block_len > MAX_DOC_COMMENT_LINES:
                    problems.append(
                        Problem(
                            path,
                            block_start,
                            "2.3",
                            f"doc comment is {block_len} lines, limit is "
                            f"{MAX_DOC_COMMENT_LINES}",
                        )
                    )
            continue

        masked = strip_string_literals(line)
        block_idx = masked.find("/*")
        if block_idx != -1:
            doc = masked[block_idx:].startswith("/**")
            closes = "*/" in masked[block_idx + 2 :]
            comments.append((lineno, line[block_idx:]))
            comment_lines.add(lineno)
            if not is_header:
                rule = "2.3" if doc else "2.6"
                what = "doc comment" if doc else "block comment"
                problems.append(Problem(path, lineno, rule, f"{what} in a body file"))
            if not closes:
                in_block = True
                block_start = lineno
                block_len = 1
                block_is_doc = doc
            elif doc:
                pass
            continue

        found = find_line_comment(line, ("//",))
        if found:
            idx, text = found
            comments.append((lineno, text))
            comment_lines.add(lineno)
            trailing = line[:idx].strip() != ""
            if trailing and len(text) > MAX_TRAILING_COMMENT_CHARS:
                problems.append(
                    Problem(
                        path,
                        lineno,
                        "2.6",
                        f"trailing comment is {len(text)} chars, limit is "
                        f"{MAX_TRAILING_COMMENT_CHARS}",
                    )
                )

    problems += check_common(path, comments)
    problems += check_runs_and_density(path, lines, comment_lines, is_header)
    return problems


def check_python(path: Path, lines: list[str]) -> list[Problem]:
    comments: list[tuple[int, str]] = []
    comment_lines: set[int] = set()
    for lineno, raw in enumerate(lines, 1):
        line = raw.rstrip("\n")
        if lineno == 1 and line.startswith("#!"):
            continue
        found = find_line_comment(line, ("#",))
        if found:
            idx, text = found
            comments.append((lineno, text))
            comment_lines.add(lineno)
            if line[:idx].strip() and len(text) > MAX_TRAILING_COMMENT_CHARS:
                comments.append((lineno, text))
    problems = check_common(path, comments)
    problems += check_runs_and_density(path, lines, comment_lines, is_header=False)
    return problems


def check_file(path: Path) -> list[Problem]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError:
        return []
    if is_generated(lines):
        return check_generated_banner(path, lines)
    if path.suffix in PY_SUFFIXES:
        return check_python(path, lines)
    is_header = path.suffix in C_HEADER_SUFFIXES
    return check_c_like(path, lines, is_header)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", type=Path)
    args = parser.parse_args()

    targets = [p.resolve() for p in args.paths] or [REPO_ROOT]
    problems: list[Problem] = []
    files = iter_source_files(targets)
    for path in files:
        problems.extend(check_file(path))

    problems.sort(key=lambda p: (str(p.path), p.line))
    for problem in problems:
        print(problem.render(REPO_ROOT))

    print(f"check_comments: {len(files)} file(s), {len(problems)} problem(s)", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
