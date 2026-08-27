"""E2-T9: core stays branch-agnostic.

Two ways to break the rule: importing from tasks/, or naming a branch inline.
Both are checked statically, so the test fails even for code paths no test
exercises.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

CORE_DIR = Path(__file__).resolve().parent.parent / "src" / "facepipe" / "core"
BRANCH_NAMES = ("detection", "antispoof", "recognition")


def core_files() -> list[Path]:
    return sorted(CORE_DIR.glob("*.py"))


def test_core_directory_is_populated() -> None:
    assert core_files(), f"no modules under {CORE_DIR}"


@pytest.mark.parametrize("path", core_files(), ids=lambda p: p.name)
def test_core_does_not_import_tasks(path: Path) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    offenders = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            offenders += [a.name for a in node.names if _is_tasks(a.name)]
        elif isinstance(node, ast.ImportFrom) and node.module and _is_tasks(node.module):
            offenders.append(node.module)
    assert not offenders, f"{path.name} imports from tasks: {', '.join(offenders)}"


@pytest.mark.parametrize("path", core_files(), ids=lambda p: p.name)
def test_core_does_not_name_a_branch(path: Path) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    offenders = [
        f"{node.value!r} at line {node.lineno}"
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and any(branch in node.value.lower() for branch in BRANCH_NAMES)
    ]
    offenders += [
        f"{name} at line {node.lineno}"
        for node in ast.walk(tree)
        for name in _bound_names(node)
        if any(branch in name.lower() for branch in BRANCH_NAMES)
    ]
    assert not offenders, f"{path.name} names a branch: {'; '.join(offenders)}"


def _is_tasks(module: str) -> bool:
    return module == "facepipe.tasks" or module.startswith("facepipe.tasks.")


def _bound_names(node: ast.AST) -> list[str]:
    if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
        return [node.name]
    if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
        return [node.id]
    if isinstance(node, ast.arg):
        return [node.arg]
    return []
