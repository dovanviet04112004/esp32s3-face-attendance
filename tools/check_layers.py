#!/usr/bin/env python3
"""Enforce the firmware dependency layering of KEHOACH section 4.5.4.

Reads REQUIRES and PRIV_REQUIRES out of every component CMakeLists.txt, builds
the dependency graph and fails when an edge points sideways or upwards.
Exit code is 1 when any rule is violated.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FIRMWARE_ROOT = REPO_ROOT / "firmware"

LAYERS: dict[str, int] = {
    "common": 0,
    "bsp_board": 1,
    "drv_ioexp": 1,
    "drv_camera": 2,
    "drv_lcd": 2,
    "drv_touch": 2,
    "drv_tof": 2,
    "drv_audio": 2,
    "drv_relay": 2,
    "drv_servo": 2,
    "sys_storage": 2,
    "sys_time": 2,
    "ai_engine": 3,
    "svc_facedb": 3,
    "net_wifi": 3,
    "net_mqtt": 3,
    "net_ota": 3,
    "svc_door": 4,
    "svc_vision": 4,
    "svc_attendance": 5,
    "svc_sync": 5,
    "ui_kiosk": 6,
    "main": 7,
}

FORBIDDEN_EDGES: set[tuple[str, str]] = {
    ("ui_kiosk", "svc_attendance"),
    ("ui_kiosk", "svc_vision"),
    ("ui_kiosk", "svc_sync"),
    ("ui_kiosk", "svc_facedb"),
    ("svc_attendance", "ui_kiosk"),
}

REGISTER_RE = re.compile(r"idf_component_register\s*\((.*?)\)", re.DOTALL)
REQUIRES_RE = re.compile(
    r"\b(PRIV_REQUIRES|REQUIRES)\b(.*?)(?=\b[A-Z_]{3,}\b\s|$)", re.DOTALL
)
KEYWORD_RE = re.compile(r"^[A-Z_]{3,}$")


@dataclass
class Problem:
    component: str
    rule: str
    detail: str

    def render(self) -> str:
        return f"{self.component}: [{self.rule}] {self.detail}"


def strip_cmake_comments(text: str) -> str:
    return "\n".join(line.split("#", 1)[0] for line in text.splitlines())


def parse_requires(cmake_path: Path) -> set[str]:
    text = strip_cmake_comments(cmake_path.read_text(encoding="utf-8"))
    found: set[str] = set()
    for block in REGISTER_RE.findall(text):
        for _, raw in REQUIRES_RE.findall(block):
            for token in raw.replace('"', " ").split():
                if KEYWORD_RE.match(token):
                    break
                found.add(token)
    return found


def collect_components(firmware_root: Path) -> dict[str, set[str]]:
    graph: dict[str, set[str]] = {}
    components_dir = firmware_root / "components"
    candidates = []
    if components_dir.is_dir():
        candidates += [d for d in sorted(components_dir.iterdir()) if d.is_dir()]
    main_dir = firmware_root / "main"
    if main_dir.is_dir():
        candidates.append(main_dir)
    for directory in candidates:
        cmake = directory / "CMakeLists.txt"
        if cmake.is_file():
            graph[directory.name] = parse_requires(cmake)
    return graph


def check_graph(graph: dict[str, set[str]]) -> list[Problem]:
    problems: list[Problem] = []
    for component, deps in sorted(graph.items()):
        if component not in LAYERS:
            problems.append(
                Problem(component, "4.5.4", "component is absent from the layer table")
            )
            continue
        own_layer = LAYERS[component]
        for dep in sorted(deps):
            if dep not in LAYERS:
                continue
            if (component, dep) in FORBIDDEN_EDGES:
                problems.append(
                    Problem(
                        component,
                        "4.5.4",
                        f"must reach {dep} through a queue or event, never a direct REQUIRES",
                    )
                )
                continue
            dep_layer = LAYERS[dep]
            if dep_layer == own_layer:
                problems.append(
                    Problem(component, "4.5.4", f"sideways dependency on {dep} (both L{own_layer})")
                )
            elif dep_layer > own_layer:
                problems.append(
                    Problem(
                        component,
                        "4.5.4",
                        f"upward dependency on {dep} (L{own_layer} -> L{dep_layer})",
                    )
                )
    return problems


def find_cycles(graph: dict[str, set[str]]) -> list[list[str]]:
    cycles: list[list[str]] = []
    state: dict[str, int] = {}
    stack: list[str] = []

    def walk(node: str) -> None:
        state[node] = 1
        stack.append(node)
        for dep in sorted(graph.get(node, ())):
            if dep not in graph:
                continue
            if state.get(dep, 0) == 0:
                walk(dep)
            elif state.get(dep) == 1:
                cycles.append(stack[stack.index(dep) :] + [dep])
        stack.pop()
        state[node] = 2

    for node in sorted(graph):
        if state.get(node, 0) == 0:
            walk(node)
    return cycles


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--firmware-root", type=Path, default=FIRMWARE_ROOT)
    args = parser.parse_args()

    graph = collect_components(args.firmware_root)
    problems = check_graph(graph)
    for cycle in find_cycles(graph):
        problems.append(Problem(cycle[0], "4.5.4", "dependency cycle " + " -> ".join(cycle)))

    for problem in problems:
        print(problem.render())

    print(
        f"check_layers: {len(graph)} component(s), {len(problems)} problem(s)",
        file=sys.stderr,
    )
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
