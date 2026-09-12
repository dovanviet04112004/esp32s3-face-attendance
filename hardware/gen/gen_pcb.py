"""Emit hardware/kicad/kiosk.kicad_pcb: footprints placed, nets attached, outline cut.

Placement follows the five ground rules of KE HOACH section 2.5, so the two
supplies sit side by side with one tie between them, each heavy load returns to
its own terminal, and the amplifier keeps its distance from the I2C bus.
"""

import hashlib
import re
from pathlib import Path

SCH = Path("hardware/kicad/kiosk.kicad_sch")
OUT = Path("hardware/kicad/kiosk.kicad_pcb")
STOCK = Path("/mnt/d/KiCad/share/kicad/footprints")
LOCAL = Path("hardware/lib/footprints/kiosk.pretty")
BOARD_W, BOARD_H = 158.0, 116.0
EDGE = 0.0
# Panel PCB measured off the module. It stands 8.5 mm up on J3 and covers its
# rectangle whole, so nothing taller than that may sit inside (KEHOACH 2.3A).
LCD_PANEL = (61.0, 107.0)
# 🔬 Header row to the panel's near edge, and hole centre to panel edge. Neither is
# measured; the header one is capped by the 11.2 mm strip past the glass (KEHOACH 2.3A).
LCD_HEADER_INSET = 6.0
LCD_HOLE_INSET = 3.5
HOLE_FP = "MountingHole:MountingHole_2.7mm"

# ref -> (x, y, rotation). A stock connector footprint has its origin on pin 1, so
# the point given is its top end; U1 is drawn in-house and placed by its centre.
PLACEMENT = {
    # Face: ToF over the devkit, panel flat to their right, its capacitor on the
    # strip below where an 11 mm can clears the 8.5 mm the panel stands at.
    "J4": (13.5, 18.0, 90),
    "U1": (20.0, 62.0, 0),
    # Low enough that the panel's far edge clears the top of the board, since the
    # panel reaches 107 mm up from wherever its header lands.
    "J3": (57.0, 105.0, 90),
    # A 107 mm panel leaves no strip under itself, so its capacitor goes to the
    # left of it, below the devkit, which is the nearest 3V3 the panel does not cover.
    "C4": (38.0, 102.0, 90),
    # Right of the panel, three bands. Band 1, y 6..54: the I2C parts.
    "J13": (129.0, 34.32, 180),
    "J5": (111.0, 9.0, 90),
    "J6": (138.0, 12.0, 90),
    # Turned round so the 3V3 leg meets J6.VCC and the SDA leg meets J6.SDA, the
    # only two pads on the board 2.54 mm apart carrying those nets. Centred on J6.
    "R1": (149.43, 20.0, 180),
    # Band 2, y 58..80: the two loads that switch, each with its capacitor beside
    # it. J7 sits at the left edge of the amplifier's outline so C2 can reach it.
    "J7": (110.0, 62.0, 0),
    "C2": (110.0, 86.0, 0),
    "J9": (143.0, 62.0, 0),
    "C3": (149.0, 64.54, 0),
    # Band 3, y 84..108: the supplies side by side so their grounds meet at one
    # point (rule 1), J11 keeping its offset from J9 so rule 2 survives the move.
    "C1": (134.0, 94.0, 0),
    "J10": (134.0, 109.0, 0),
    "J11": (147.0, 109.0, 0),
}


def lcd_area() -> tuple:
    """The panel rectangle, anchored on the header it plugs into rather than guessed."""
    x, y, _ = PLACEMENT["J3"]
    centre = x + (14 - 1) * 2.54 / 2.0
    near = y + LCD_HEADER_INSET
    return (round(centre - LCD_PANEL[0] / 2, 2), round(near - LCD_PANEL[1], 2),
            round(centre + LCD_PANEL[0] / 2, 2), round(near, 2))


LCD_AREA = lcd_area()
# A plugged-in module keeps its body, and that body lands on the board. Drawn on
# the silkscreen so nothing is placed inside one. 🔬 only the RTC is measured.
MODULE_AREA = {
    "J3 LCD 4.0in": LCD_AREA,
    "J4 VL53L1X": (7.5, 5.0, 32.5, 20.0),
    "J5 PCF8574 48x16": (108.0, 6.0, 124.0, 54.0),
    "J7 MAX98357A": (106.0, 60.0, 126.0, 80.0),
}


def lcd_holes() -> dict:
    """M2.5 clearance at the panel's four corners, so J3 carries no load."""
    x0, y0, x1, y1 = LCD_AREA
    inset = LCD_HOLE_INSET
    corners = ((x0 + inset, y0 + inset), (x1 - inset, y0 + inset),
               (x1 - inset, y1 - inset), (x0 + inset, y1 - inset))
    return {f"H{i + 1}": (round(hx, 2), round(hy, 2), 0)
            for i, (hx, hy) in enumerate(corners)}


def uid(*parts: object) -> str:
    h = hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()
    return f"{h[:8]}-{h[8:12]}-4{h[13:16]}-8{h[17:20]}-{h[20:32]}"


def parse(text: str) -> list:
    """Nested lists; tokens keep their quotes so re-emitting is lossless."""
    stack: list[list] = [[]]
    for token in re.findall(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()]+', text):
        if token == "(":
            stack.append([])
        elif token == ")":
            stack[-2].append(stack.pop())
        else:
            stack[-1].append(token)
    return stack[0][0]


def emit(node, depth: int = 0) -> str:
    pad = "\t" * depth
    if isinstance(node, str):
        return node
    head = node[0] if node and isinstance(node[0], str) else ""
    flat = all(isinstance(c, str) for c in node)
    if flat:
        return f"{pad}({' '.join(node)})"
    parts = [f"{pad}({head}"]
    for child in node[1:]:
        parts.append(emit(child, depth + 1) if not isinstance(child, str)
                     else f"{pad}\t{child}")
    parts.append(f"{pad})")
    return "\n".join(parts)


def unquote(token: str) -> str:
    return token[1:-1] if token.startswith('"') else token


def children(node: list, tag: str) -> list:
    return [c for c in node if isinstance(c, list) and c and c[0] == tag]


def first(node: list, tag: str):
    got = children(node, tag)
    return got[0] if got else None


def schematic_nets() -> tuple[dict, dict]:
    """Footprint name and pin-number-to-net for every placed symbol."""
    tree = parse(SCH.read_text(encoding="utf-8"))
    pins_of = {}
    for sym in children(first(tree, "lib_symbols"), "symbol"):
        name = unquote(sym[1]).split(":", 1)[-1]
        found = {}
        for unit in children(sym, "symbol"):
            for pin in children(unit, "pin"):
                at = first(pin, "at")
                number = unquote(first(pin, "number")[1])
                found[number] = (float(at[1]), float(at[2]))
        pins_of[name] = found

    wires = []
    for wire in children(tree, "wire"):
        pts = children(first(wire, "pts"), "xy")
        wires.append(tuple(float(v) for p in pts for v in p[1:3]))
    labels = [(unquote(n[1]), float(first(n, "at")[1]), float(first(n, "at")[2]))
              for n in children(tree, "label")]

    def near(ax, ay, bx, by):
        return abs(ax - bx) < 0.01 and abs(ay - by) < 0.01

    footprint, nets = {}, {}
    for sym in children(tree, "symbol"):
        lib = first(sym, "lib_id")
        if lib is None:
            continue
        name = unquote(lib[1]).split(":", 1)[-1]
        ref = fp = None
        for prop in children(sym, "property"):
            if unquote(prop[1]) == "Reference":
                ref = unquote(prop[2])
            elif unquote(prop[1]) == "Footprint":
                fp = unquote(prop[2])
        at = first(sym, "at")
        ox, oy = float(at[1]), float(at[2])
        footprint[ref] = fp
        nets[ref] = {}
        for number, (lx, ly) in pins_of[name].items():
            px, py = ox + lx, oy - ly
            for x1, y1, x2, y2 in wires:
                far = ((x2, y2) if near(x1, y1, px, py)
                       else (x1, y1) if near(x2, y2, px, py) else None)
                if far is None:
                    continue
                for net, lax, lay in labels:
                    if near(lax, lay, *far):
                        nets[ref][number] = net
    return footprint, nets


def load_footprint(spec: str) -> list:
    lib, _, name = spec.partition(":")
    root = LOCAL if lib == "kiosk" else STOCK / f"{lib}.pretty"
    return parse((root / f"{name}.kicad_mod").read_text(encoding="utf-8"))


# pcb upgrade mints a random uuid for every one of these that arrives without
# one, so a regenerated board diffs in ~2000 lines unless they are named first.
UUID_NODES = ("fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_text",
              "pad", "property")


def place(ref: str, spec: str, pin_nets: dict, net_id: dict, spot: tuple) -> list:
    x, y, rot = spot
    tree = load_footprint(spec)
    # tree[1] is the footprint's own name, a bare string; the board names it itself.
    body = [c for c in tree[1:]
            if isinstance(c, list) and c[0] not in ("version", "generator",
                                                    "generator_version")]
    out = ["footprint", f'"{spec}"', ["layer", '"F.Cu"'], ["uuid", f'"{uid("fp", ref)}"'],
           ["at", str(x), str(y)] + ([str(rot)] if rot else [])]
    seen: dict = {}
    # pcb upgrade fills these two in itself if they are absent, with a fresh uuid.
    for field in ("Datasheet", "Description"):
        body = body + [["property", f'"{field}"', '""', ["at", "0", "0", "0"],
                        ["layer", '"F.Fab"'], ["hide", "yes"],
                        ["uuid", f'"{uid("prop", ref, field)}"'],
                        ["effects", ["font", ["size", "1.27", "1.27"]]]]]
    for node in body:
        if node[0] == "layer" or node[0] == "at":
            continue
        if node[0] == "property":
            node = list(node)
            if unquote(node[1]) == "Reference":
                node[2] = f'"{ref}"'
            # KiCad carries the placement angle down into each text, so a rotated
            # footprint whose text stays at zero reads as altered from its library.
            if rot:
                node = [([c[0], c[1], c[2], str((float(c[3] if len(c) > 3 else 0) + rot) % 360)]
                         if isinstance(c, list) and c[0] == "at" else c) for c in node]
        if node[0] == "pad":
            number = unquote(node[1])
            net = pin_nets.get(number)
            node = list(node)
            if net:
                node.append(["net", str(net_id[net]), f'"{net}"'])
        if node[0] in UUID_NODES:
            node = list(node)
            seen[node[0]] = seen.get(node[0], 0) + 1
            if not any(isinstance(c, list) and c[0] == "uuid" for c in node):
                node.append(["uuid", f'"{uid("in", ref, node[0], seen[node[0]])}"'])
        out.append(node)
    return out


# Track widths: the Power class of kiosk.kicad_pro, because section 2.5 puts 1.34 A
# of peak on rail 1 and 0.7 A on rail 2, and 0.25 mm does not carry that.
ROUTE = False          # placement only until the layout is signed off
POWER_MM, SIGNAL_MM = 1.0, 0.25
# Every pad here is through-hole, so a track on either layer reaches it: supplies
# on the back and signals on the front halves the crowding with no vias.
POWER_LAYER, SIGNAL_LAYER = '"B.Cu"', '"F.Cu"'


def pad_points(doc: list) -> dict:
    """Net name -> [(ref.pad, x, y)] in board coordinates."""
    import math
    found: dict = {}
    for fp in [n for n in doc if isinstance(n, list) and n[0] == "footprint"]:
        ref = next((unquote(p[2]) for p in children(fp, "property")
                    if len(p) > 2 and unquote(p[1]) == "Reference"), "?")
        at = first(fp, "at")
        ox, oy = float(at[1]), float(at[2])
        th = math.radians(float(at[3]) if len(at) > 3 else 0.0)
        for pad in children(fp, "pad"):
            net = first(pad, "net")
            if not net:
                continue
            a = first(pad, "at")
            lx, ly = float(a[1]), float(a[2])
            found.setdefault(unquote(net[-1]), []).append(
                (f"{ref}.{unquote(pad[1])}",
                 round(ox + lx * math.cos(th) + ly * math.sin(th), 3),
                 round(oy - lx * math.sin(th) + ly * math.cos(th), 3)))
    return found


def spanning_edges(points: list) -> list:
    """Prim over the pads, so each net is joined with the least total track."""
    if len(points) < 2:
        return []
    inside, outside = [points[0]], list(points[1:])
    edges = []
    while outside:
        best = min(((a, b) for a in inside for b in outside),
                   key=lambda pair: (pair[0][1] - pair[1][1]) ** 2 + (pair[0][2] - pair[1][2]) ** 2)
        edges.append(best)
        inside.append(best[1])
        outside.remove(best[1])
    return edges


def track(tag: str, a: tuple, b: tuple, width: float, layer: str, net: int) -> list:
    return ["segment", ["start", str(a[0]), str(a[1])], ["end", str(b[0]), str(b[1])],
            ["width", str(width)], ["layer", layer], ["net", str(net)],
            ["uuid", f'"{uid("trk", tag)}"']]


def route(tag: str, a: tuple, b: tuple, width: float, layer: str, net: int) -> list:
    """One corner, horizontal first; a zero-length leg is dropped."""
    corner = (b[1], a[2])
    out = []
    if abs(a[1] - corner[0]) > 0.001:
        out.append(track(tag + "h", (a[1], a[2]), corner, width, layer, net))
    if abs(corner[1] - b[2]) > 0.001:
        out.append(track(tag + "v", corner, (b[1], b[2]), width, layer, net))
    return out


# Rule 1 of section 2.5: the two grounds meet at exactly one point, at the terminals.
RAIL2_GROUND = {"J11.2", "J9.1", "C3.2"}
GROUND_TIE = ("J10.2", "J11.2")


def pin_labels(doc: list) -> list:
    """A signal name printed beside every pad, so a hole can be identified by eye."""
    import math
    import gen_sch
    names = {}
    for ref, value, left, right, x, y in gen_sch.PARTS:
        for i, (name, net) in enumerate(left, 1):
            names[(ref, str(i))] = name
        for i, (name, net) in enumerate(right, len(left) + 1):
            names[(ref, str(i))] = name

    out = []
    for fp in [n for n in doc if isinstance(n, list) and n[0] == "footprint"]:
        ref = next((unquote(p[2]) for p in children(fp, "property")
                    if len(p) > 2 and unquote(p[1]) == "Reference"), "?")
        at = first(fp, "at")
        ox, oy = float(at[1]), float(at[2])
        deg = float(at[3]) if len(at) > 3 else 0.0
        th = math.radians(deg)
        pads = children(fp, "pad")
        seats = {}
        for pad in pads:
            a = first(pad, "at")
            lx, ly = float(a[1]), float(a[2])
            seats[unquote(pad[1])] = (ox + lx * math.cos(th) + ly * math.sin(th),
                                      oy - lx * math.sin(th) + ly * math.cos(th), lx)
        for pad in pads:
            number = unquote(pad[1])
            label = names.get((ref, number))
            if not label:
                continue
            px, py, lx = seats[number]
            # U1 has room between its two rows; everything else reads outward.
            if ref == "U1":
                dx, dy, rot, just = (4.0 if lx < 0 else -4.0), 0.0, 0, ("left" if lx < 0 else "right")
            elif len(pads) == 2:
                # On a two-pad row an inboard label lands on the other pad's copper.
                away = -1.0 if px <= sum(s[0] for s in seats.values()) / 2 else 1.0
                dx, dy, rot, just = 1.6 * away, 0.0, 0, ("right" if away < 0 else "left")
            elif abs(deg - 90) < 1:
                # rotated text grows back toward the pad unless justified away from it
                dx, dy, rot, just = 0.0, 2.0, 90, "right"
            else:
                dx, dy, rot, just = -2.0, 0.0, 0, "right"
            out.append(["gr_text", f'"{label}"',
                        ["at", f"{px + dx:.2f}", f"{py + dy:.2f}", str(rot)],
                        ["layer", '"F.SilkS"'],
                        ["uuid", f'"{uid("lbl", ref, label)}"'],
                        ["effects", ["font", ["size", "0.8", "0.8"], ["thickness", "0.12"]],
                         ["justify", just]]])
    return out


def main() -> None:
    footprint, nets = schematic_nets()
    every = sorted({n for pins in nets.values() for n in pins.values()})
    net_id = {name: i + 1 for i, name in enumerate(every)}

    doc = ["kicad_pcb", ["version", "20241229"], ["generator", '"kiosk-gen"'],
           ["generator_version", '"9.0"'],
           ["general", ["thickness", "1.6"], ["legacy_teardrops", "no"]],
           ["paper", '"A4"'],
           ["layers", ["0", '"F.Cu"', "signal"], ["2", '"B.Cu"', "signal"],
            ["9", '"F.Adhes"', "user", '"F.Adhesive"'], ["11", '"B.Adhes"', "user", '"B.Adhesive"'],
            ["13", '"F.Paste"', "user"], ["15", '"B.Paste"', "user"],
            ["5", '"F.SilkS"', "user", '"F.Silkscreen"'], ["7", '"B.SilkS"', "user", '"B.Silkscreen"'],
            ["1", '"F.Mask"', "user"], ["3", '"B.Mask"', "user"],
            ["17", '"Dwgs.User"', "user", '"User.Drawings"'],
            ["19", '"Cmts.User"', "user", '"User.Comments"'],
            ["21", '"Eco1.User"', "user", '"User.Eco1"'], ["23", '"Eco2.User"', "user", '"User.Eco2"'],
            ["25", '"Edge.Cuts"', "user"], ["27", '"Margin"', "user"],
            ["31", '"F.CrtYd"', "user", '"F.Courtyard"'], ["29", '"B.CrtYd"', "user", '"B.Courtyard"'],
            ["35", '"F.Fab"', "user"], ["33", '"B.Fab"', "user"]],
           ["setup", ["pad_to_mask_clearance", "0"]],
           ["net", "0", '""']]
    for name, number in net_id.items():
        doc.append(["net", str(number), f'"{name}"'])

    corners = [(EDGE, EDGE), (BOARD_W, EDGE), (BOARD_W, BOARD_H), (EDGE, BOARD_H)]
    for i, start in enumerate(corners):
        end = corners[(i + 1) % 4]
        doc.append(["gr_line", ["start", str(start[0]), str(start[1])],
                    ["end", str(end[0]), str(end[1])],
                    ["stroke", ["width", "0.1"], ["type", "default"]],
                    ["layer", '"Edge.Cuts"'], ["uuid", f'"{uid("edge", i)}"']])

    for name, (x0, y0, x1, y1) in MODULE_AREA.items():
        box = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        for i, start in enumerate(box):
            end = box[(i + 1) % 4]
            doc.append(["gr_line", ["start", str(start[0]), str(start[1])],
                        ["end", str(end[0]), str(end[1])],
                        ["stroke", ["width", "0.2"], ["type", "dash"]],
                        ["layer", '"F.SilkS"'], ["uuid", f'"{uid("area", name, i)}"']])

    for ref, spot in PLACEMENT.items():
        doc.append(place(ref, footprint[ref], nets[ref], net_id, spot))
    for ref, spot in lcd_holes().items():
        doc.append(place(ref, HOLE_FP, {}, net_id, spot))

    doc += pin_labels(doc)
    pads = pad_points(doc)
    laid = 0
    for name, number in (net_id.items() if ROUTE else ()):
        group = pads.get(name, [])
        power = name.startswith("+") or name == "GND"
        width = POWER_MM if power else SIGNAL_MM
        layer = POWER_LAYER if power else SIGNAL_LAYER
        if name == "GND":
            near = [p for p in group if p[0] in RAIL2_GROUND]
            far = [p for p in group if p[0] not in RAIL2_GROUND]
            runs = [(f"gnd2", near), ("gnd1", far)]
            tie = {p[0]: p for p in group}
            for i, (tag, part) in enumerate(runs):
                for j, (a, b) in enumerate(spanning_edges(part)):
                    doc += route(f"{tag}{j}", a, b, width, layer, number)
                    laid += 1
            doc += route("gndtie", tie[GROUND_TIE[0]], tie[GROUND_TIE[1]], width, layer, number)
            laid += 1
            continue
        for j, (a, b) in enumerate(spanning_edges(group)):
            doc += route(f"{name}{j}", a, b, width, layer, number)
            laid += 1

    OUT.write_text(emit(doc) + "\n", encoding="utf-8")
    print(f"{OUT}: {len(PLACEMENT)} footprint, {len(net_id)} net, board {BOARD_W}x{BOARD_H} mm")
    missing = sorted(set(footprint) - set(PLACEMENT))
    if missing:
        print(f"  !! chua dat: {missing}")


if __name__ == "__main__":
    main()
