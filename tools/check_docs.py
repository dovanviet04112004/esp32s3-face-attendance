#!/usr/bin/env python3
"""Keep the Markdown docs true to each other and to the repo (CLAUDE.md 4.4).

Every doc: links, heading anchors, section references, the table of contents,
heading structure, tables, fences and `make` targets. Docs about the present,
not the TASKS, ADR, measurement and thesis logs: repo paths and history words.
Code: the plan sections its comments cite. --fix rewrites each table of contents.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

REPO_ROOT = Path(__file__).resolve().parent.parent
PLAN = Path("docs/KE_HOACH_face_attendance_esp32s3.md")
RULES = Path("CLAUDE.md")
MAKEFILE = Path("Makefile")
TOC_TITLE = "Mục lục"
TOC_MAX_LEVEL = 3

LOG_FILES = {Path("docs/TASKS.md"), Path("docs/FREERTOS.md")}
LOG_DIRS = (Path("docs/adr"), Path("docs/measurements"), Path("docs/thesis"))
VENDORED_PARTS = {"node_modules", "managed_components"}
CODE_SUFFIXES = {
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".hpp",
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".cjs",
    ".yml",
    ".yaml",
    ".prisma",
    ".sh",
    ".cmake",
    ".csv",
    ".toml",
}
CODE_NAMES = {"Makefile", "CMakeLists.txt", "Dockerfile", "Kconfig", "Kconfig.projbuild"}
TOP_DIRS = (
    "android",
    "backend",
    "contracts",
    "deploy",
    "docs",
    "firmware",
    "frontend",
    "hardware",
    "ml",
    "tools",
    ".github",
)
HISTORY_WORDS = ("trước đây", "trước nay", "bản đầu", "lúc trước", "hồi trước", "đã từng")
BRANCHES = ("antispoof", "detection", "recognition", "rppg")

SECTION = r"\d+(?:\.\d+)*[A-Za-z]?"
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
HEADING = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$")
CODE_SPAN = re.compile(r"(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)")
LINK = re.compile(r"!?\[(?:[^\[\]]|\[[^\[\]]*\])*\]\(\s*<?([^\s<>()]+)>?(?:\s+\"[^\"]*\")?\s*\)")
LINK_TEXT = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
REF_DEF = re.compile(r"^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)")
SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
LINE_ANCHOR = re.compile(r"^L\d+(?:-L?\d+)?$")
DOC_REF = re.compile(
    rf"§\s?({SECTION})(?:\s+[Ll]ớp\s+(\d+))?(?:\s?[\N{{EN DASH}}-]\s?§?({SECTION}))?"
)
PLAN_CITE = re.compile(
    rf"(?:KE_?HOACH|KẾ HOẠCH)\s*§?\s?({SECTION})(?:\s+(?:layer|[Ll]ớp)\s+(\d+))?"
)
PLAN_CITE_PLAIN = re.compile(rf"KE_?HOACH\s+({SECTION})(?:\s+(?:layer|[Ll]ớp)\s+(\d+))?")
PLAN_NAME = re.compile(r"(?:KẾ HOẠCH|[Kk]ế hoạch|KE_?HOACH)$")
DOC_NAME = re.compile(r"([\w.-]+(?:/[\w.-]+)*)$")
BRANCH_NAME = re.compile(rf"(?<![\w/.-])({'|'.join(BRANCHES)})$")
EXTERNAL_NAME = re.compile(r"(?<![\w-])(?:[Dd]atasheet|DS|TRM|IPC-\d+)(?:\s+[\w.-]+){0,3}$")
AFTER_NAME = re.compile(
    r"^\s*(?:(?:luật|bước|mục)\s+\d+\s+)?(?:của\s+)?[`*]*([\w.-]+(?:/[\w.-]+)*)[`*]*(?=[\s),.;:]|$)"
)
LIST_GAP = re.compile(r"^(?:\s*(?:,|;|và|\N{EN DASH}|-)\s*)+$")
NUMBERED = re.compile(rf"^({SECTION})[.)]?(?=\s|$)")
LETTERED = re.compile(r"^([A-Za-z])[.)](?=\s)")
LAYER = re.compile(r"^[Ll]ớp\s+(\d+)\b")
ITEM = re.compile(r"^\*\*(\d+)\.\s")
KEY_PARTS = re.compile(r"^(\d+(?:\.\d+)*)([A-Za-z]?)$")
DELIMITER = re.compile(r"^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$")
TARGET = re.compile(r"^([A-Za-z0-9][\w.-]*(?:[ \t]+[A-Za-z0-9][\w.-]*)*)[ \t]*:(?![:=])")
MAKE_CALL = re.compile(r"(?:^|&&|;|\|\||\$)\s*make\s+([^;&|#]*)")
TARGET_WORD = re.compile(r"^[a-z0-9][\w.-]*$")
LINE_SUFFIX = re.compile(r":\d+(?:-\d+)?$")
REPO_PATH = re.compile(rf"^(?:{'|'.join(re.escape(d) for d in TOP_DIRS)})/[\w.@+/-]*$")
HISTORY = re.compile(
    rf"(?<!\w)({'|'.join(re.escape(w) for w in HISTORY_WORDS)})(?!\w)", re.IGNORECASE
)


@dataclass
class Problem:
    path: Path
    line: int
    rule: str
    detail: str

    def render(self) -> str:
        return f"{self.path.as_posix()}:{self.line}: [{self.rule}] {self.detail}"


@dataclass
class Heading:
    line: int
    level: int
    text: str
    slug: str
    key: str | None  # "4.5.5f", "2.3A", "3 lớp 5"
    numbered: bool  # the key is the heading's own number
    parent: int | None


@dataclass
class Doc:
    path: Path
    lines: list[str]
    fenced: list[bool]
    unclosed: int | None
    headings: list[Heading]
    keys: dict[str, int]  # section key -> the line that opens it
    slugs: set[str]


def git(*args: str, stdin: str | None = None) -> str:
    done = subprocess.run(
        ["git", "-C", str(REPO_ROOT), *args], input=stdin, capture_output=True, text=True
    )
    return done.stdout


def repo_files() -> set[Path]:
    """Tracked files plus the new ones git would add, so CI and a clone see one set."""
    out = git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
    return {Path(p) for p in out.split("\0") if p and (REPO_ROOT / p).is_file()}


def ignored(paths: list[str]) -> set[str]:
    return (
        set(git("check-ignore", "--stdin", stdin="\n".join(paths)).splitlines()) if paths else set()
    )


def vendored(path: Path) -> bool:
    parts = set(path.parts)
    return bool(parts & VENDORED_PARTS) or {"third_party", "src"} <= parts


def is_log(path: Path) -> bool:
    return path in LOG_FILES or any(path.is_relative_to(d) for d in LOG_DIRS)


def fence_mask(lines: list[str]) -> tuple[list[bool], int | None]:
    fenced: list[bool] = []
    opener: str | None = None
    opened_at: int | None = None
    for n, line in enumerate(lines, 1):
        m = FENCE.match(line)
        if opener is None:
            if m:
                opener, opened_at = m.group(1), n
            fenced.append(m is not None)
            continue
        fenced.append(True)
        closes = m and m.group(1)[0] == opener[0] and len(m.group(1)) >= len(opener)
        if closes and not line.strip(" \t`~"):
            opener = None
    return fenced, opened_at if opener else None


def spans(line: str) -> list[str]:
    return [m.group(2) for m in CODE_SPAN.finditer(line)]


def unspanned(line: str) -> str:
    return CODE_SPAN.sub(lambda m: " " * len(m.group(0)), line)


def plain(text: str) -> str:
    text = LINK_TEXT.sub(r"\1", text)
    text = re.sub(r"<[^>]*>", "", text).replace("`", "")
    return re.sub(r"(\*\*|__|\*)(?=\S)(.+?)(?<=\S)\1", r"\2", text).strip()


def slugify(text: str) -> str:
    """GitHub's anchor for a heading: lower case, punctuation and symbols dropped."""
    kept = [c for c in plain(text).lower() if c in " -_" or unicodedata.category(c)[0] in "LMN"]
    return "".join(kept).replace(" ", "-")


def heading_key(text: str, owner: str | None) -> tuple[str | None, bool]:
    if m := NUMBERED.match(text):
        return m.group(1), True
    if owner and (m := LETTERED.match(text)):
        return owner + m.group(1), False
    if owner and (m := LAYER.match(text)):
        return f"{owner} lớp {m.group(1)}", False
    return None, False


def parse(path: Path) -> Doc:
    lines = (REPO_ROOT / path).read_text(encoding="utf-8").splitlines()
    fenced, unclosed = fence_mask(lines)
    headings: list[Heading] = []
    items: dict[str, int] = {}
    stack: list[int] = []
    seen: dict[str, int] = {}
    for n, line in enumerate(lines, 1):
        if fenced[n - 1]:
            continue
        owner = next((headings[i].key for i in reversed(stack) if headings[i].numbered), None)
        if not (m := HEADING.match(line)):
            # A bold "**6. …**" paragraph is item 6 of its section: code cites it as 9.17.6.
            if owner and (item := ITEM.match(line)):
                items.setdefault(f"{owner}.{item.group(1)}", n)
            continue
        level, text = len(m.group(1)), (m.group(2) or "").strip()
        while stack and headings[stack[-1]].level >= level:
            stack.pop()
        owner = next((headings[i].key for i in reversed(stack) if headings[i].numbered), None)
        key, numbered = heading_key(text, owner)
        base = slugify(text)
        slug = f"{base}-{seen[base]}" if base in seen else base
        seen[base] = seen.get(base, 0) + 1
        headings.append(Heading(n, level, text, slug, key, numbered, stack[-1] if stack else None))
        stack.append(len(headings) - 1)
    keys: dict[str, int] = {}
    for h in headings:
        if h.key:
            keys.setdefault(h.key, h.line)
    for key, n in items.items():
        keys.setdefault(key, n)
    return Doc(path, lines, fenced, unclosed, headings, keys, {h.slug for h in headings})


def load_docs(files: set[Path]) -> dict[Path, Doc]:
    docs = {p: parse(p) for p in sorted(files) if p.suffix == ".md" and not vendored(p)}
    # CLAUDE.md is gitignored: read when present so local runs check citations of it.
    if RULES not in docs and (REPO_ROOT / RULES).is_file():
        docs[RULES] = parse(RULES)
    return docs


def link_problem(doc: Doc, target: str, docs: dict[Path, Doc], known: set[Path]) -> str | None:
    raw, _, fragment = target.partition("#")
    raw = unquote(raw.split("?")[0])
    resolved = doc.path
    if raw:
        base = Path() if raw.startswith("/") else doc.path.parent
        resolved = Path(os.path.normpath(base / raw.lstrip("/")))
        if resolved not in known:
            return f"'{target}' points at nothing in the repo"
    if not fragment:
        return None
    if LINE_ANCHOR.match(fragment):
        return (
            f"'{target}' anchors a line, and lines move with every edit; link the file or a heading"
        )
    if resolved in docs and unquote(fragment) not in docs[resolved].slugs:
        return f"'#{fragment}' is no heading of {resolved.as_posix()}"
    return None


def check_links(doc: Doc, docs: dict[Path, Doc], known: set[Path]) -> list[Problem]:
    problems = []
    for n, line in enumerate(doc.lines, 1):
        if doc.fenced[n - 1]:
            continue
        text = unspanned(line)
        targets = [m.group(1) for m in LINK.finditer(text)]
        if m := REF_DEF.match(text):
            targets.append(m.group(1))
        for target in targets:
            if not SCHEME.match(target) and (detail := link_problem(doc, target, docs, known)):
                problems.append(Problem(doc.path, n, "link", detail))
    return problems


Target = tuple[str, Path | None]  # kind: doc, bare, unverifiable or unknown


@dataclass
class Repo:
    docs: dict[Path, Doc]
    known: set[Path]  # every file and folder
    folders: set[str]  # every folder and each tail of its path


def named_doc(name: str, quoted: bool, here: Path, repo: Repo) -> Target | None:
    """The doc a name in prose stands for: `latency.md`, `measurements/antispoof`, `DU_LIEU`."""
    if name.endswith(".md"):
        wanted = [name]
    elif "/" in name and name in repo.folders:
        wanted = [f"{name}/measurements.md", f"{name}/README.md"]
    elif quoted and "/" not in name and "." not in name:
        stems = [p for p in repo.docs if p.stem == name]
        return ("doc", stems[0]) if len(stems) == 1 else (("unverifiable", None) if stems else None)
    else:
        return None
    for want in wanted:
        hits = [p for p in repo.docs if p.as_posix() == want or p.as_posix().endswith("/" + want)]
        near = [p for p in hits if p.parent == here.parent]
        if len(near) == 1:
            return "doc", near[0]
        if len(hits) == 1:
            return "doc", hits[0]
        if hits:
            return "unverifiable", None
    # CLAUDE.md is gitignored, so CI has no copy to check against.
    return ("unverifiable", None) if name == RULES.name else ("unknown", None)


def ref_target(doc: Doc, before: str, after: str, repo: Repo) -> Target:
    """Which doc a § points into: named before it, named after it, or bare."""
    quoted = bool(re.search(r"`[\w./-]+`\W*$", before))
    before = before.rstrip(" \t`*_([)]")
    if PLAN_NAME.search(before) or re.match(r"^\s*(?:của\s+)?(?:KẾ HOẠCH|KE_?HOACH)", after):
        return "doc", PLAN
    if EXTERNAL_NAME.search(before):
        return "unverifiable", None
    if (m := DOC_NAME.search(before)) and (found := named_doc(m.group(1), quoted, doc.path, repo)):
        return found
    if m := AFTER_NAME.match(after):
        name = m.group(1)
        if name.lower() == "datasheet":
            return "unverifiable", None
        if name in BRANCHES:
            return "doc", Path(f"docs/measurements/{name}/measurements.md")
        if found := named_doc(name, "`" in m.group(0), doc.path, repo):
            return found
    if doc.path != PLAN and (m := BRANCH_NAME.search(before)):
        return "doc", Path(f"docs/measurements/{m.group(1)}/measurements.md")
    return "bare", None


def cite_key(section: str, layer: str | None) -> str:
    return f"{section} lớp {layer}" if layer else section


def has_section(doc: Doc, key: str) -> bool:
    if key in doc.keys:
        return True
    # "§7.2 lớp 3" names a layer inside a section that has no layer headings of its own.
    section, _, layer = key.partition(" lớp ")
    return (
        bool(layer)
        and section in doc.keys
        and not any(k.startswith(f"{section} lớp ") for k in doc.keys)
    )


def bare_homes(doc: Doc, docs: dict[Path, Doc]) -> list[Doc]:
    """Where a bare § may point: this doc, its branch's measurements.md, then the plan."""
    homes = [doc] if doc.path != PLAN else []
    sibling = doc.path.parent / "measurements.md"
    if sibling != doc.path and sibling in docs and doc.path.parent.parent == LOG_DIRS[1]:
        homes.append(docs[sibling])
    return [*homes, docs[PLAN]]


def check_sections(doc: Doc, repo: Repo) -> list[Problem]:
    docs = repo.docs
    problems = []
    for n, line in enumerate(doc.lines, 1):
        lead = "" if n == 1 or not doc.lines[n - 2].strip() else doc.lines[n - 2] + " "
        previous: tuple[int, Target] | None = None
        for m in DOC_REF.finditer(line):
            if previous and LIST_GAP.match(line[previous[0] : m.start()]):
                target = previous[1]
            else:
                target = ref_target(doc, lead + line[: m.start()], line[m.end() :], repo)
            previous = (m.end(), target)
            kind, path = target
            if kind == "unverifiable":
                continue
            if kind == "unknown":
                problems.append(Problem(doc.path, n, "section", f"§{m.group(1)} names no doc"))
                continue
            homes = [docs[path]] if path in docs else [] if kind == "doc" else bare_homes(doc, docs)
            where = path.as_posix() if path else " or ".join(h.path.name for h in homes)
            for key in filter(None, (cite_key(m.group(1), m.group(2)), m.group(3))):
                if not any(has_section(home, key) for home in homes):
                    problems.append(
                        Problem(doc.path, n, "section", f"§{key} is no section of {where}")
                    )
        for m in PLAN_CITE_PLAIN.finditer(line):
            if not has_section(docs[PLAN], key := cite_key(m.group(1), m.group(2))):
                problems.append(
                    Problem(doc.path, n, "section", f"KEHOACH {key} is no section of the plan")
                )
    return problems


def toc_heading(doc: Doc) -> Heading | None:
    return next((h for h in doc.headings if plain(h.text) == TOC_TITLE), None)


def toc_span(doc: Doc, toc: Heading) -> tuple[int, int]:
    end = toc.line
    while (
        end < len(doc.lines)
        and doc.lines[end].strip() != "---"
        and not HEADING.match(doc.lines[end])
    ):
        end += 1
    return toc.line, end


def toc_lines(doc: Doc, toc: Heading) -> list[str]:
    entries = []
    for h in doc.headings:
        if h.line > toc.line and 2 <= h.level <= TOC_MAX_LEVEL:
            text = LINK_TEXT.sub(r"\1", h.text)
            entries.append("  " * (h.level - 2) + f"- [{text}](#{h.slug})")
    return ["", *entries, ""]


def check_toc(doc: Doc) -> list[Problem]:
    toc = toc_heading(doc)
    if toc is None:
        return []
    start, end = toc_span(doc, toc)
    have, want = doc.lines[start:end], toc_lines(doc, toc)
    if have == want:
        return []
    first = next(
        (i for i, (a, b) in enumerate(zip(have, want, strict=False)) if a != b),
        min(len(have), len(want)),
    )
    expected = want[first].strip() if first < len(want) else "(end)"
    detail = f"the table of contents differs from the headings, expected '{expected}'; run --fix"
    return [Problem(doc.path, start + first + 1, "toc", detail)]


def fix_toc(doc: Doc) -> bool:
    toc = toc_heading(doc)
    if toc is None:
        return False
    start, end = toc_span(doc, toc)
    want = toc_lines(doc, toc)
    if doc.lines[start:end] == want:
        return False
    lines = [*doc.lines[:start], *want, *doc.lines[end:]]
    (REPO_ROOT / doc.path).write_text("\n".join(lines) + "\n", encoding="utf-8")
    return True


def order(key: str) -> tuple[tuple[int, ...], str] | None:
    m = KEY_PARTS.match(key)
    return (tuple(int(p) for p in m.group(1).split(".")), m.group(2).lower()) if m else None


def check_headings(doc: Doc) -> list[Problem]:
    problems = []
    if not doc.headings or doc.headings[0].level != 1:
        line = doc.headings[0].line if doc.headings else 1
        problems.append(
            Problem(doc.path, line, "heading", "the doc does not open with its # title")
        )
    for h in [h for h in doc.headings if h.level == 1][1:]:
        problems.append(Problem(doc.path, h.line, "heading", "a second # title; a doc has one"))
    previous = 0
    last: dict[tuple[int | None, int], tuple[Heading, tuple[tuple[int, ...], str]]] = {}
    for h in doc.headings:
        if previous and h.level > previous + 1:
            problems.append(
                Problem(doc.path, h.line, "heading", f"jumps from level {previous} to {h.level}")
            )
        previous = h.level
        if h.key and doc.keys[h.key] != h.line:
            first = doc.keys[h.key]
            problems.append(
                Problem(doc.path, h.line, "heading", f"§{h.key} also opens line {first}")
            )
        rank = order(h.key) if h.key else None
        if rank is None:
            continue
        owner = next((doc.headings[i] for i in ancestors(doc, h) if doc.headings[i].numbered), None)
        if h.numbered and owner and not str(h.key).startswith(f"{owner.key}."):
            problems.append(
                Problem(doc.path, h.line, "heading", f"§{h.key} sits under §{owner.key}")
            )
        sibling = last.get((h.parent, h.level))
        if sibling and rank <= sibling[1]:
            detail = f"§{h.key} comes after §{sibling[0].key}; sections run in order"
            problems.append(Problem(doc.path, h.line, "heading", detail))
        last[(h.parent, h.level)] = (h, rank)
    return problems


def ancestors(doc: Doc, h: Heading) -> list[int]:
    chain = []
    parent = h.parent
    while parent is not None:
        chain.append(parent)
        parent = doc.headings[parent].parent
    return chain


def cells(row: str) -> int:
    body = row.strip()
    body = body[1:] if body.startswith("|") else body
    body = body[:-1] if body.endswith("|") and not body.endswith("\\|") else body
    return len(re.split(r"(?<!\\)\|", body))


def check_tables(doc: Doc) -> list[Problem]:
    problems = []
    lines, i = doc.lines, 0
    while i < len(lines) - 1:
        header, rule = lines[i], lines[i + 1]
        if doc.fenced[i] or "|" not in header or not DELIMITER.match(rule) or "-" not in rule:
            i += 1
            continue
        width = cells(header)
        if cells(rule) != width:
            detail = f"the delimiter row has {cells(rule)} cells, the header {width}"
            problems.append(Problem(doc.path, i + 2, "table", detail))
        i += 2
        while i < len(lines) and lines[i].strip() and "|" in lines[i] and not doc.fenced[i]:
            if (count := cells(lines[i])) != width:
                detail = f"the row has {count} cells, the header {width}; escape a literal | as \\|"
                problems.append(Problem(doc.path, i + 1, "table", detail))
            i += 1
    return problems


def makefile_targets() -> set[str]:
    targets: set[str] = set()
    inside_define = False
    for line in (REPO_ROOT / MAKEFILE).read_text(encoding="utf-8").splitlines():
        if line.startswith("define "):
            inside_define = True
        elif line.startswith("endef"):
            inside_define = False
        elif not inside_define and (m := TARGET.match(line)):
            targets.update(m.group(1).split())
    return targets


def called_targets(args: str) -> list[str]:
    words = []
    for word in args.split():
        if "=" in word or word.startswith("-"):
            continue
        if not TARGET_WORD.match(word):
            break
        words.append(word)
    return words


def check_make(doc: Doc, targets: set[str]) -> list[Problem]:
    problems = []
    for n, line in enumerate(doc.lines, 1):
        # After `git checkout <rev>` the command runs against that revision's Makefile.
        if "git checkout" in line or (n > 1 and "git checkout" in doc.lines[n - 2]):
            continue
        for text in [line] if doc.fenced[n - 1] else spans(line):
            for m in MAKE_CALL.finditer(text):
                for word in called_targets(m.group(1)):
                    if word not in targets:
                        problems.append(
                            Problem(doc.path, n, "make", f"`make {word}`: no such target")
                        )
    return problems


def missing_paths(doc: Doc, known: set[Path]) -> list[tuple[int, str]]:
    found = []
    for n, line in enumerate(doc.lines, 1):
        if doc.fenced[n - 1]:
            continue
        for span in spans(line):
            path = LINE_SUFFIX.sub("", span.strip())
            if "..." in path or not REPO_PATH.match(path):
                continue
            # A bare `firmware/svc_vision` is a commit scope; files carry a suffix, folders a slash.
            if not path.endswith("/") and "." not in path.rsplit("/", 1)[-1]:
                continue
            if Path(path.rstrip("/")) not in known:
                found.append((n, path))
    return found


def probe(path: str) -> str:
    """A name git can test for ignore rules: a folder is ignored when a file in it would be."""
    return f"{path}.probe" if path.endswith("/") else path


def check_history(doc: Doc) -> list[Problem]:
    problems = []
    for n, line in enumerate(doc.lines, 1):
        if doc.fenced[n - 1]:
            continue
        for m in HISTORY.finditer(unspanned(line)):
            detail = f"'{m.group(1)}' narrates history; this doc states the present (CLAUDE.md 1.2)"
            problems.append(Problem(doc.path, n, "history", detail))
    return problems


def check_fence(doc: Doc) -> list[Problem]:
    if doc.unclosed is None:
        return []
    return [
        Problem(
            doc.path, doc.unclosed, "fence", "this fence never closes; the rest renders as code"
        )
    ]


def check_code(path: Path, plan: Doc) -> list[Problem]:
    try:
        text = (REPO_ROOT / path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    problems = []
    for n, line in enumerate(text.splitlines(), 1):
        for m in PLAN_CITE.finditer(line):
            if not has_section(plan, key := cite_key(m.group(1), m.group(2))):
                problems.append(
                    Problem(path, n, "section", f"KEHOACH {key} is no section of the plan")
                )
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("paths", nargs="*", type=Path, help="files or folders; default the repo")
    parser.add_argument("--fix", action="store_true", help="rewrite each table of contents")
    args = parser.parse_args()

    roots = [p.resolve().relative_to(REPO_ROOT) for p in args.paths] or [Path()]

    def chosen(path: Path) -> bool:
        return any(path.is_relative_to(root) for root in roots)

    files = repo_files()
    folders = {parent for path in files for parent in path.parents}
    known = files | folders
    tails = {"/".join(f.parts[i:]) for f in folders for i in range(len(f.parts))}
    docs = load_docs(files)
    repo = Repo(docs, known, tails)
    checked = [p for p in docs if p in files and chosen(p)]
    if args.fix:
        for path in checked:
            if fix_toc(docs[path]):
                docs[path] = parse(path)

    targets = makefile_targets()
    problems: list[Problem] = []
    missing: list[tuple[Path, int, str]] = []
    for path in checked:
        doc = docs[path]
        problems += check_links(doc, docs, known) + check_sections(doc, repo)
        problems += check_toc(doc) + check_headings(doc) + check_tables(doc) + check_fence(doc)
        problems += check_make(doc, targets)
        if not is_log(path):
            problems += check_history(doc)
            missing += [(path, n, p) for n, p in missing_paths(doc, known)]
    skipped = ignored([probe(p) for _, _, p in missing])
    for path, n, p in missing:
        if probe(p) not in skipped:
            problems.append(Problem(path, n, "path", f"`{p}` is not in the repo"))

    sources = [
        p
        for p in sorted(files)
        if (p.suffix in CODE_SUFFIXES or p.name in CODE_NAMES)
        and not (set(p.parts) & (VENDORED_PARTS | {"third_party"}))
        and chosen(p)
    ]
    for path in sources:
        problems += check_code(path, docs[PLAN])

    problems.sort(key=lambda p: (p.path.as_posix(), p.line))
    for problem in problems:
        print(problem.render())
    summary = f"{len(checked)} doc(s), {len(sources)} code file(s), {len(problems)} problem(s)"
    print(f"check_docs: {summary}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
