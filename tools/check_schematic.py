#!/usr/bin/env python3
"""Check the carrier schematic against the pin map the firmware compiles.

Reads APP_*_GPIO out of app_config.h and the net sitting on every devkit pin of
kiosk.kicad_sch, then fails when a pin carries a net its macro does not name.
CLAUDE.md section 1.3 keeps the pin map in two places on purpose; this is what
stops the two from drifting. Exit code is 1 when anything disagrees.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

HEADER = "firmware/components/bsp_board/include/app_config.h"
SCHEMATIC = "hardware/kicad/kiosk.kicad_sch"
DEVKIT = "kiosk:U1"
TOLERANCE = 0.01
CHAR_MM = 0.85
# A 1.27 mm glyph plus clearance, kept under the 2.54 mm pin pitch so that two
# labels one pin apart stay legal while text that crowds another reads as a fault.
LINE_MM = 2.3

# Soldered to the devkit through its own DVP socket, so they never reach the carrier.
SKIP_GROUPS = ("CAM",)

# Fitted on the devkit, so the carrier routes no copper to them (KEHOACH 2.4).
SKIP_MACROS = ("APP_STATUS_LED_GPIO", "APP_FACTORY_RESET_GPIO")



@dataclass
class Problem:
    where: str
    detail: str

    def render(self) -> str:
        return f"{self.where}: {self.detail}"


def parse_sexp(text: str) -> list:
    """The whole file as nested lists, strings unquoted."""
    stack: list[list] = [[]]
    for token in re.findall(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()]+', text):
        if token == "(":
            stack.append([])
        elif token == ")":
            stack[-2].append(stack.pop())
        else:
            stack[-1].append(token[1:-1] if token.startswith('"') else token)
    return stack[0][0]


def children(node: list, tag: str) -> list[list]:
    return [c for c in node if isinstance(c, list) and c and c[0] == tag]


def first(node: list, tag: str) -> list | None:
    found = children(node, tag)
    return found[0] if found else None


def macro_gpios(header: Path) -> dict[str, int]:
    text = header.read_text(encoding="utf-8")
    found = re.findall(r"#define\s+(APP_(\w+?)_\w+_GPIO)\s+(\d+)", text)
    return {macro: int(pin) for macro, group, pin in found
            if group not in SKIP_GROUPS and macro not in SKIP_MACROS}


def expected_net(macro: str) -> str:
    """APP_LCD_DC_GPIO names net LCD_DC, with no table in between."""
    return macro.removeprefix("APP_").removesuffix("_GPIO")


def devkit_nets(tree: list) -> tuple[dict[str, str], list[Problem]]:
    """Net name against each devkit pin name, read off the drawn geometry."""
    problems: list[Problem] = []

    library = None
    for symbol in children(first(tree, "lib_symbols") or [], "symbol"):
        if symbol[1] == DEVKIT:
            library = symbol
    if library is None:
        return {}, [Problem(DEVKIT, "no such symbol in the library")]

    pins = {}
    for unit in children(library, "symbol"):
        for pin in children(unit, "pin"):
            at, name = first(pin, "at"), first(pin, "name")
            pins[name[1]] = (float(at[1]), float(at[2]))

    placement = None
    for symbol in children(tree, "symbol"):
        lib_id = first(symbol, "lib_id")
        if lib_id and lib_id[1] == DEVKIT:
            placement = first(symbol, "at")
    if placement is None:
        return {}, [Problem(DEVKIT, "symbol is in the library but not on the sheet")]
    origin_x, origin_y = float(placement[1]), float(placement[2])

    wires = []
    for wire in children(tree, "wire"):
        points = children(first(wire, "pts"), "xy")
        wires.append(tuple(float(v) for p in points for v in p[1:3]))
    labels = [(node[1], float(first(node, "at")[1]), float(first(node, "at")[2]))
              for node in children(tree, "label")]

    def near(ax: float, ay: float, bx: float, by: float) -> bool:
        return abs(ax - bx) < TOLERANCE and abs(ay - by) < TOLERANCE

    nets = {}
    for pin_name, (local_x, local_y) in pins.items():
        px, py = origin_x + local_x, origin_y - local_y
        for x1, y1, x2, y2 in wires:
            far = (x2, y2) if near(x1, y1, px, py) else (x1, y1) if near(x2, y2, px, py) else None
            if far is None:
                continue
            for net, lx, ly in labels:
                if near(lx, ly, *far):
                    if pin_name in nets and nets[pin_name] != net:
                        problems.append(Problem(pin_name, f"two nets: {nets[pin_name]}, {net}"))
                    nets[pin_name] = net
    return nets, problems


def text_boxes(tree: list) -> list[tuple[str, float, float, float, float]]:
    """Every drawn string with the box it occupies, at the 1.27 mm font."""
    boxes = []
    for symbol in children(tree, "symbol"):
        if first(symbol, "lib_id") is None:
            continue
        for field in children(symbol, "property"):
            if field[1] not in ("Reference", "Value") or not field[2]:
                continue
            if children(field, "hide"):
                continue
            at = first(field, "at")
            boxes.append((field[2], float(at[1]), float(at[2])))
    for label in children(tree, "label"):
        at = first(label, "at")
        boxes.append((label[1], float(at[1]), float(at[2])))
    return [(text, x - len(text) * CHAR_MM / 2, x + len(text) * CHAR_MM / 2,
             y - LINE_MM / 2, y + LINE_MM / 2) for text, x, y in boxes]


def overlaps(tree: list) -> list[Problem]:
    boxes = text_boxes(tree)
    found = []
    for i, (text, x0, x1, y0, y1) in enumerate(boxes):
        for other, ox0, ox1, oy0, oy1 in boxes[i + 1:]:
            if x0 < ox1 and ox0 < x1 and y0 < oy1 and oy0 < y1:
                found.append(Problem("sheet", f'"{text}" sits on "{other}"'))
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()

    header, schematic = args.root / HEADER, args.root / SCHEMATIC
    if not schematic.exists():
        print(f"check_schematic: {SCHEMATIC} not drawn yet, nothing to check", file=sys.stderr)
        return 0

    gpios = macro_gpios(header)
    tree = parse_sexp(schematic.read_text(encoding="utf-8"))
    nets, problems = devkit_nets(tree)
    problems += overlaps(tree)

    for macro, gpio in sorted(gpios.items(), key=lambda kv: kv[1]):
        want, got = expected_net(macro), nets.get(f"IO{gpio}")
        if got is None:
            problems.append(Problem(f"GPIO{gpio}", f"{macro} names it, no net on that pin"))
        elif got != want:
            problems.append(Problem(f"GPIO{gpio}", f"{macro} wants {want}, sheet has {got}"))

    owners: dict[str, list[str]] = {}
    for pin, net in nets.items():
        owners.setdefault(net, []).append(pin)
    for net, pins in sorted(owners.items()):
        if len(pins) > 1:
            problems.append(Problem(net, "on more than one devkit pin: " + ", ".join(sorted(pins))))

    for problem in problems:
        print(problem.render())
    print(f"check_schematic: {len(gpios)} pin(s), {len(problems)} problem(s)", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
