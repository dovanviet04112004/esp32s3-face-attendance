#!/usr/bin/env python3
"""Check the carrier PCB against the schematic it is drawn from.

Every symbol placed, every pad on the net its pin carries, no polarised capacitor
with its plus leg on ground, nothing off the board or under another part. Read
from the committed files rather than the generator, so it catches what KiCad
wrote too. Exit code is 1 when anything disagrees.
"""

from __future__ import annotations

import argparse
import math
import re
import sys
from pathlib import Path

SCHEMATIC = "hardware/kicad/kiosk.kicad_sch"
BOARD = "hardware/kicad/kiosk.kicad_pcb"
TOLERANCE = 0.01
# 0.8 mm glyphs at the stroke width gen_pcb uses for a pin label.
GLYPH_MM = 0.62
LINE_MM = 1.0
POLARISED = "CP_Radial"


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


def first(node: list, tag: str):
    found = children(node, tag)
    return found[0] if found else None


def place(ox: float, oy: float, deg: float, lx: float, ly: float) -> tuple[float, float]:
    """A footprint-local point in board coordinates."""
    th = math.radians(deg)
    return (ox + lx * math.cos(th) + ly * math.sin(th),
            oy - lx * math.sin(th) + ly * math.cos(th))


def sheet_nets(tree: list) -> dict[str, dict[str, str]]:
    """Reference -> pin number -> net, traced along each pin's wire to its label."""
    pins_of = {}
    for symbol in children(first(tree, "lib_symbols") or [], "symbol"):
        found = {}
        for unit in children(symbol, "symbol"):
            for pin in children(unit, "pin"):
                at = first(pin, "at")
                found[first(pin, "number")[1]] = (float(at[1]), float(at[2]))
        pins_of[symbol[1].split(":", 1)[-1]] = found

    wires = []
    for wire in children(tree, "wire"):
        points = children(first(wire, "pts"), "xy")
        wires.append(tuple(float(v) for p in points for v in p[1:3]))
    labels = [(n[1], float(first(n, "at")[1]), float(first(n, "at")[2]))
              for n in children(tree, "label")]

    def near(ax, ay, bx, by):
        return abs(ax - bx) < TOLERANCE and abs(ay - by) < TOLERANCE

    nets: dict[str, dict[str, str]] = {}
    for symbol in children(tree, "symbol"):
        lib_id = first(symbol, "lib_id")
        if lib_id is None:
            continue
        ref = next((p[2] for p in children(symbol, "property") if p[1] == "Reference"), None)
        at = first(symbol, "at")
        ox, oy = float(at[1]), float(at[2])
        nets[ref] = {}
        for number, (lx, ly) in pins_of[lib_id[1].split(":", 1)[-1]].items():
            px, py = ox + lx, oy - ly
            for x1, y1, x2, y2 in wires:
                far = ((x2, y2) if near(x1, y1, px, py)
                       else (x1, y1) if near(x2, y2, px, py) else None)
                if far is None:
                    continue
                for net, lax, lay in labels:
                    if near(lax, lay, *far):
                        nets[ref][number] = net
    return nets


def board_parts(tree: list) -> dict[str, dict]:
    """Reference -> footprint name, pads and courtyard corners, all in board space."""
    parts = {}
    for fp in children(tree, "footprint"):
        ref = next((p[2] for p in children(fp, "property") if p[1] == "Reference"), "?")
        at = first(fp, "at")
        ox, oy = float(at[1]), float(at[2])
        deg = float(at[3]) if len(at) > 3 else 0.0
        pads = {}
        for pad in children(fp, "pad"):
            a = first(pad, "at")
            net = first(pad, "net")
            pads[pad[1]] = {
                "xy": place(ox, oy, deg, float(a[1]), float(a[2])),
                "net": net[-1] if net else None,
                "shape": pad[3],
                "size": max(float(v) for v in first(pad, "size")[1:3]),
            }
        corners = []
        for node in children(fp, "fp_line") + children(fp, "fp_rect"):
            layer = first(node, "layer")
            if layer and layer[1] == "F.CrtYd":
                for tag in ("start", "end"):
                    pt = first(node, tag)
                    if pt:
                        corners.append(place(ox, oy, deg, float(pt[1]), float(pt[2])))
        parts[ref] = {"spec": fp[1], "pads": pads, "crtyd": corners}
    return parts


def outline(tree: list, layer: str, dashed: bool | None = None) -> list[tuple]:
    """Every segment drawn on one layer, as (x1, y1, x2, y2)."""
    found = []
    for node in children(tree, "gr_line"):
        on = first(node, "layer")
        if not on or on[1] != layer:
            continue
        stroke = first(node, "stroke")
        kind = first(stroke, "type")[1] if stroke and first(stroke, "type") else "solid"
        if dashed is not None and (kind == "dash") != dashed:
            continue
        start, end = first(node, "start"), first(node, "end")
        found.append((float(start[1]), float(start[2]), float(end[1]), float(end[2])))
    return found


def boxes_from(segments: list[tuple]) -> list[tuple]:
    """Axis-aligned rectangles recovered from their four drawn sides."""
    corners: dict[tuple, list] = {}
    for x1, y1, x2, y2 in segments:
        key = (round(min(x1, x2), 3), round(min(y1, y2), 3),
               round(max(x1, x2), 3), round(max(y1, y2), 3))
        corners.setdefault("all", []).append(key)
    xs = [v for box in corners.get("all", []) for v in (box[0], box[2])]
    ys = [v for box in corners.get("all", []) for v in (box[1], box[3])]
    return [(min(xs), min(ys), max(xs), max(ys))] if xs else []


def text_boxes(tree: list) -> list[tuple]:
    """Silkscreen strings with the rectangle each one inks."""
    found = []
    for node in children(tree, "gr_text"):
        layer = first(node, "layer")
        if not layer or layer[1] != "F.SilkS":
            continue
        at = first(node, "at")
        x, y = float(at[1]), float(at[2])
        rot = float(at[3]) if len(at) > 3 else 0.0
        justify = first(first(node, "effects") or [], "justify")
        side = justify[1] if justify else "center"
        width = len(node[1]) * GLYPH_MM
        span = {"left": (0.0, width), "right": (-width, 0.0),
                "center": (-width / 2, width / 2)}[side]
        a = place(x, y, rot, span[0], -LINE_MM / 2)
        b = place(x, y, rot, span[1], LINE_MM / 2)
        found.append((node[1], min(a[0], b[0]), min(a[1], b[1]),
                      max(a[0], b[0]), max(a[1], b[1])))
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()

    schematic, board = args.root / SCHEMATIC, args.root / BOARD
    if not board.exists():
        print(f"check_pcb: {BOARD} not drawn yet, nothing to check", file=sys.stderr)
        return 0

    sheet = parse_sexp(schematic.read_text(encoding="utf-8"))
    pcb = parse_sexp(board.read_text(encoding="utf-8"))
    want = sheet_nets(sheet)
    parts = board_parts(pcb)
    problems: list[str] = []

    for ref, pins in sorted(want.items()):
        if ref not in parts:
            problems.append(f"{ref}: on the sheet, not on the board")
            continue
        for number, net in sorted(pins.items()):
            pad = parts[ref]["pads"].get(number)
            if pad is None:
                problems.append(f"{ref}.{number}: no such pad in {parts[ref]['spec']}")
            elif pad["net"] != net:
                problems.append(f"{ref}.{number}: pad carries {pad['net']}, sheet says {net}")

    carried: dict[str, list[str]] = {}
    for ref, part in parts.items():
        for number, pad in part["pads"].items():
            if pad["net"]:
                carried.setdefault(pad["net"], []).append(f"{ref}.{number}")
    for net, pads in sorted(carried.items()):
        if len(pads) < 2:
            problems.append(f"{net}: reaches only {pads[0]}")

    for ref, part in sorted(parts.items()):
        if POLARISED not in part["spec"]:
            continue
        plus = part["pads"].get("1")
        if plus is None or plus["net"] == "GND":
            problems.append(f"{ref}: the plus pad sits on ground")
        elif plus["shape"] not in ("rect", "roundrect"):
            problems.append(f"{ref}: pad 1 is {plus['shape']}, nothing marks which leg is plus")

    edge = boxes_from(outline(pcb, "Edge.Cuts"))
    if edge:
        x0, y0, x1, y1 = edge[0]
        for ref, part in sorted(parts.items()):
            for point in [p["xy"] for p in part["pads"].values()] + part["crtyd"]:
                if not (x0 <= point[0] <= x1 and y0 <= point[1] <= y1):
                    problems.append(f"{ref}: ({point[0]:.1f}, {point[1]:.1f}) falls outside the board")
                    break

    hulls = {}
    for ref, part in parts.items():
        if part["crtyd"]:
            xs = [p[0] for p in part["crtyd"]]
            ys = [p[1] for p in part["crtyd"]]
            hulls[ref] = (min(xs), min(ys), max(xs), max(ys))
    refs = sorted(hulls)
    for i, a in enumerate(refs):
        for b in refs[i + 1:]:
            ax0, ay0, ax1, ay1 = hulls[a]
            bx0, by0, bx1, by1 = hulls[b]
            if ax0 < bx1 and bx0 < ax1 and ay0 < by1 and by0 < ay1:
                problems.append(f"{a} and {b}: courtyards overlap")

    for text, tx0, ty0, tx1, ty1 in text_boxes(pcb):
        for ref, part in sorted(parts.items()):
            for number, pad in part["pads"].items():
                px, py = pad["xy"]
                r = pad["size"] / 2
                if tx0 < px + r and px - r < tx1 and ty0 < py + r and py - r < ty1:
                    problems.append(f'"{text}": silkscreen covers pad {ref}.{number}')

    for problem in problems:
        print(problem)
    print(f"check_pcb: {len(parts)} part(s), {len(carried)} net(s), "
          f"{len(problems)} problem(s)", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
