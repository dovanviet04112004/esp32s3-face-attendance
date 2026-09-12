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
from collections import Counter
from pathlib import Path

SCHEMATIC = "hardware/kicad/kiosk.kicad_sch"
BOARD = "hardware/kicad/kiosk.kicad_pcb"
TOLERANCE = 0.01
# 0.8 mm glyphs at the stroke width gen_pcb uses for a pin label.
GLYPH_MM = 0.62
LINE_MM = 1.0
# Designators are set at 1 mm rather than the 0.8 mm gen_pcb gives a pin name.
REF_GLYPH_MM = 0.78
POLARISED = "CP_Radial"
# What a low-cost two-layer house quotes without asking questions.
MIN_DRILL_MM, MIN_RING_MM = 0.3, 0.2
# The two classes of kiosk.kicad_pro, which section 2.5 sizes from the peak amps.
POWER_WIDTH_MM, SIGNAL_WIDTH_MM = 1.0, 0.25


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
            drill = first(pad, "drill")
            pads[pad[1]] = {
                "xy": place(ox, oy, deg, float(a[1]), float(a[2])),
                "net": net[-1] if net else None,
                "shape": pad[3],
                "size": max(float(v) for v in first(pad, "size")[1:3]),
                "narrow": min(float(v) for v in first(pad, "size")[1:3]),
                "drill": float(drill[1]) if drill else None,
                "plated": pad[2] == "thru_hole",
            }
        corners = []
        for node in children(fp, "fp_line") + children(fp, "fp_rect"):
            layer = first(node, "layer")
            if layer and layer[1] == "F.CrtYd":
                for tag in ("start", "end"):
                    pt = first(node, tag)
                    if pt:
                        corners.append(place(ox, oy, deg, float(pt[1]), float(pt[2])))
        # A can or a mounting hole draws its courtyard as a circle, and a part the
        # overlap test cannot see is a part nothing stops from landing on another.
        for node in children(fp, "fp_circle"):
            layer = first(node, "layer")
            if not layer or layer[1] != "F.CrtYd":
                continue
            mid, rim = first(node, "center"), first(node, "end")
            cx, cy = float(mid[1]), float(mid[2])
            radius = math.dist((cx, cy), (float(rim[1]), float(rim[2])))
            hub = place(ox, oy, deg, cx, cy)
            corners += [(hub[0] + sx * radius, hub[1] + sy * radius)
                        for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
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
    """One axis-aligned rectangle per closed loop, grouped by shared endpoints."""
    loops: list[dict] = []
    for x1, y1, x2, y2 in segments:
        ends = {(round(x1, 3), round(y1, 3)), (round(x2, 3), round(y2, 3))}
        joined = {"ends": set(ends), "pts": [(x1, y1), (x2, y2)]}
        for loop in [g for g in loops if g["ends"] & ends]:
            joined["ends"] |= loop["ends"]
            joined["pts"] += loop["pts"]
            loops.remove(loop)
        loops.append(joined)
    return [(min(p[0] for p in g["pts"]), min(p[1] for p in g["pts"]),
             max(p[0] for p in g["pts"]), max(p[1] for p in g["pts"])) for g in loops]


def silk_strings(tree: list) -> list[tuple]:
    """Every visible front-silkscreen string: the pin names and the designators."""
    found = [(n, 1.0) for n in children(tree, "gr_text")]
    for fp in children(tree, "footprint"):
        at = first(fp, "at")
        ox, oy = float(at[1]), float(at[2])
        deg = float(at[3]) if len(at) > 3 else 0.0
        for prop in children(fp, "property"):
            if prop[1] != "Reference" or children(prop, "hide"):
                continue
            spot = first(prop, "at")
            moved = place(ox, oy, deg, float(spot[1]), float(spot[2]))
            found.append(([prop[0], prop[2], ["at", str(moved[0]), str(moved[1]), "0"],
                           *[c for c in prop[3:] if not (isinstance(c, list) and c[0] == "at")]],
                          REF_GLYPH_MM / GLYPH_MM))
    return found


def text_boxes(tree: list) -> list[tuple]:
    """Silkscreen strings with the rectangle each one inks."""
    found = []
    for node, scale in silk_strings(tree):
        layer = first(node, "layer")
        if not layer or layer[1] != "F.SilkS":
            continue
        at = first(node, "at")
        x, y = float(at[1]), float(at[2])
        rot = float(at[3]) if len(at) > 3 else 0.0
        justify = first(first(node, "effects") or [], "justify")
        side = justify[1] if justify else "center"
        width = len(node[1]) * GLYPH_MM * scale
        span = {"left": (0.0, width), "right": (-width, 0.0),
                "center": (-width / 2, width / 2)}[side]
        a = place(x, y, rot, span[0], -LINE_MM / 2)
        b = place(x, y, rot, span[1], LINE_MM / 2)
        found.append((node[1], min(a[0], b[0]), min(a[1], b[1]),
                      max(a[0], b[0]), max(a[1], b[1])))
    return found


# Section 2.5 rules 1, 2, 6 and 7 are facts about where current flows, which no clearance
# check sees: cut these pads out and the first pairs must part, the second pairs must not.
RULE_CUTS = [
    ("GND", ("J10.2", "C1.2", "J11.2"),
     [("J9.1", "J7.6"), ("J9.1", "U1.40"), ("C3.2", "J16.2"), ("J18.2", "J16.2")],
     [("J7.6", "C2.2"), ("J9.1", "C3.2")], "1, 2"),
    ("GND", ("J10.2", "C1.2"), [("J7.6", "U1.40")], [("J7.6", "C2.2")], "2"),
    ("+5V_R1", ("J10.1", "C1.1"), [("U1.20", "J7.7")], [("J7.7", "C2.1")], "6, 7"),
    ("+5V_R2", ("J11.1",), [("J9.2", "J18.1")], [("J9.2", "C3.1")], "6, 7"),
]


def seg_gap(p: tuple, q: tuple, r: tuple, s: tuple) -> tuple:
    """Closest approach of two segments, and the point halfway across it."""
    def near(a, b, c):
        vx, vy = b[0] - a[0], b[1] - a[1]
        run = vx * vx + vy * vy
        t = 0.0 if run == 0 else max(0.0, min(1.0, ((c[0] - a[0]) * vx + (c[1] - a[1]) * vy) / run))
        foot = (a[0] + vx * t, a[1] + vy * t)
        return math.dist(c, foot), foot, c
    best = min(near(p, q, r), near(p, q, s), near(r, s, p), near(r, s, q), key=lambda h: h[0])
    return best[0], ((best[1][0] + best[2][0]) / 2, (best[1][1] + best[2][1]) / 2)


def copper_bits(tree: list, parts: dict, net: str) -> list:
    """Everything on one net: pads, tracks and vias, each with a reach around it."""
    bits = []
    for ref, part in parts.items():
        for number, pad in part["pads"].items():
            if pad["net"] == net:
                bits.append({"id": f"{ref}.{number}", "layer": None,
                             "a": pad["xy"], "b": pad["xy"], "r": pad["size"] / 2})
    for node in children(tree, "segment"):
        if first(node, "net")[-1] != net:
            continue
        start, end = first(node, "start"), first(node, "end")
        bits.append({"id": None, "layer": first(node, "layer")[1],
                     "a": (float(start[1]), float(start[2])),
                     "b": (float(end[1]), float(end[2])),
                     "r": float(first(node, "width")[1]) / 2})
    for node in children(tree, "via"):
        if first(node, "net")[-1] != net:
            continue
        at = first(node, "at")
        spot = (float(at[1]), float(at[2]))
        bits.append({"id": None, "layer": None, "a": spot, "b": spot,
                     "r": float(first(node, "size")[1]) / 2})
    return bits


def joined(bits: list, drop: tuple, cut: dict) -> list:
    """Groups of copper that touch. Cutting a pad out also cuts junctions inside it."""
    live = [b for b in bits if b["id"] not in drop]
    owner = list(range(len(live)))

    def root(k):
        while owner[k] != k:
            owner[k] = owner[owner[k]]
            k = owner[k]
        return k

    for i, one in enumerate(live):
        for j in range(i + 1, len(live)):
            two = live[j]
            if one["layer"] and two["layer"] and one["layer"] != two["layer"]:
                continue
            reach, where = seg_gap(one["a"], one["b"], two["a"], two["b"])
            if reach > one["r"] + two["r"] + TOLERANCE:
                continue
            if any(math.dist(where, spot) <= span for spot, span in cut.values()):
                continue
            owner[root(i)] = root(j)
    groups: dict = {}
    for k, bit in enumerate(live):
        groups.setdefault(root(k), []).append(bit["id"])
    return [{b for b in g if b} for g in groups.values()]


def check_rules(tree: list, parts: dict) -> list:
    """Section 2.5 rules 1, 2, 6 and 7, read off the copper rather than the plan."""
    problems = []
    for net in sorted({p["net"] for part in parts.values() for p in part["pads"].values() if p["net"]}):
        bits = copper_bits(tree, parts, net)
        whole = joined(bits, (), {})
        holding = [g for g in whole if g]
        if len(holding) > 1:
            problems.append(f"{net}: dong chia lam {len(holding)} manh roi nhau")
    seats = {f"{ref}.{number}": (pad["xy"], pad["size"] / 2)
             for ref, part in parts.items() for number, pad in part["pads"].items()}
    for net, drop, apart, together, rule in RULE_CUTS:
        cut = {pad: seats[pad] for pad in drop if pad in seats}
        groups = joined(copper_bits(tree, parts, net), drop, cut)
        where = {}
        for k, group in enumerate(groups):
            for pad in group:
                where[pad] = k
        for a, b in apart:
            if a in where and b in where and where[a] == where[b]:
                problems.append(f"luat {rule}: bo {'+'.join(drop)} ra ma {a} van noi {b}")
        for a, b in together:
            if where.get(a) != where.get(b):
                problems.append(f"luat {rule}: bo {'+'.join(drop)} ra thi {a} roi khoi {b}")
    return problems


def check_wires(tree: list) -> list:
    """Every track on the width its class calls for, every via drillable."""
    problems = []
    for node in children(tree, "segment"):
        net = first(node, "net")[-1]
        width = float(first(node, "width")[1])
        want = POWER_WIDTH_MM if net[0] == "+" or net == "GND" else SIGNAL_WIDTH_MM
        if abs(width - want) > TOLERANCE:
            problems.append(f"{net}: mot doan rong {width} mm, lop nay phai {want} mm")
    for node in children(tree, "via"):
        size = float(first(node, "size")[1])
        drill = float(first(node, "drill")[1])
        if drill < MIN_DRILL_MM:
            problems.append(f"via o {first(node, 'at')[1]}: khoan {drill} mm duoi muc {MIN_DRILL_MM}")
        if (size - drill) / 2 < MIN_RING_MM:
            problems.append(f"via o {first(node, 'at')[1]}: vanh {(size - drill) / 2:.2f} mm duoi muc {MIN_RING_MM}")
    return problems


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

    # A plated hole the fab cannot drill, or a ring it cannot hold, is caught here
    # rather than by the board house after the order is placed.
    for ref, part in sorted(parts.items()):
        for number, pad in sorted(part["pads"].items()):
            if pad["drill"] is None or not pad["plated"]:
                continue
            ring = (pad["narrow"] - pad["drill"]) / 2
            if pad["drill"] < MIN_DRILL_MM:
                problems.append(f"{ref}.{number}: drilled {pad['drill']:.2f} mm, "
                                f"under the {MIN_DRILL_MM} mm floor")
            if ring < MIN_RING_MM:
                problems.append(f"{ref}.{number}: {ring:.2f} mm of copper round the hole, "
                                f"under the {MIN_RING_MM} mm floor")

    edge = boxes_from(outline(pcb, "Edge.Cuts"))
    if edge:
        x0, y0, x1, y1 = edge[0]
        for ref, part in sorted(parts.items()):
            for point in [p["xy"] for p in part["pads"].values()] + part["crtyd"]:
                if not (x0 <= point[0] <= x1 and y0 <= point[1] <= y1):
                    problems.append(f"{ref}: ({point[0]:.1f}, {point[1]:.1f}) falls outside the board")
                    break

    # A module keeps its body once plugged in, so the dashed rectangle it stands on
    # holds its own pins and nothing else wired. Mounting holes carry no net.
    for bx0, by0, bx1, by1 in boxes_from(outline(pcb, "F.SilkS", dashed=True)):
        inside = sorted(ref for ref, part in parts.items()
                        if any(p["net"] and bx0 <= p["xy"][0] <= bx1 and by0 <= p["xy"][1] <= by1
                               for p in part["pads"].values()))
        if len(inside) > 1:
            problems.append(f"module body ({bx0:.0f}, {by0:.0f})-({bx1:.0f}, {by1:.0f}): "
                            f"holds {', '.join(inside)}")

    # The body lands square on its socket only if the row is centred across the
    # outline along the axis the row runs; 1 mm of drift is visible on the board.
    for bx0, by0, bx1, by1 in boxes_from(outline(pcb, "F.SilkS", dashed=True)):
        for ref, part in sorted(parts.items()):
            # Every row, net or none: a row of bare holes sits off centre just as visibly.
            seats = [p["xy"] for p in part["pads"].values()]
            if len(seats) < 2 or not all(bx0 <= x <= bx1 and by0 <= y <= by1 for x, y in seats):
                continue
            xs = [x for x, y in seats]
            ys = [y for x, y in seats]
            along = (max(xs) - min(xs)) >= (max(ys) - min(ys))
            mid = (min(xs) + max(xs)) / 2 if along else (min(ys) + max(ys)) / 2
            centre = (bx0 + bx1) / 2 if along else (by0 + by1) / 2
            if abs(mid - centre) > 0.3:
                problems.append(f"{ref}: sits {mid - centre:+.2f} mm off the centre of "
                                f"the body it carries")

    # A footprint placed twice brings its library uuids twice unless the generator
    # renames them, and KiCad then treats two different pads as one object.
    doubled = sorted(value for value, count in Counter(
        re.findall(r'\(uuid "([0-9a-f-]{36})"\)', board.read_text(encoding="utf-8"))
    ).items() if count > 1)
    if doubled:
        problems.append(f"{len(doubled)} uuid(s) shared by more than one node, "
                        f"first {doubled[0]}")

    problems += check_rules(pcb, parts)
    problems += check_wires(pcb)

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

    bodies = boxes_from(outline(pcb, "F.SilkS", dashed=True))
    for text, tx0, ty0, tx1, ty1 in text_boxes(pcb):
        for ref, part in sorted(parts.items()):
            for number, pad in part["pads"].items():
                px, py = pad["xy"]
                r = pad["size"] / 2
                if tx0 < px + r and px - r < tx1 and ty0 < py + r and py - r < ty1:
                    problems.append(f'"{text}": silkscreen covers pad {ref}.{number}')
        # Silk is clipped off bare copper, so a name printed over a via loses a letter.
        for node in children(pcb, "via"):
            at = first(node, "at")
            vx, vy = float(at[1]), float(at[2])
            r = float(first(node, "size")[1]) / 2
            if tx0 < vx + r and vx - r < tx1 and ty0 < vy + r and vy - r < ty1:
                problems.append(f'"{text}": silkscreen covers the via at ({vx:.1f}, {vy:.1f})')
        # A name printed under a module is legible until the module is fitted, which
        # is the moment anyone needs it, so the body it belongs to must not reach it.
        for bx0, by0, bx1, by1 in bodies:
            if tx0 < bx1 and bx0 < tx1 and ty0 < by1 and by0 < ty1:
                problems.append(f'"{text}": a module body at ({bx0:.0f}, {by0:.0f}) covers it')
        if edge and not (edge[0][0] <= tx0 and tx1 <= edge[0][2]
                         and edge[0][1] <= ty0 and ty1 <= edge[0][3]):
            problems.append(f'"{text}": silkscreen runs off the board')

    for problem in problems:
        print(problem)
    print(f"check_pcb: {len(parts)} part(s), {len(carried)} net(s), "
          f"{len(problems)} problem(s)", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
