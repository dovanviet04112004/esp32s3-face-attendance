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
BOARD_W, BOARD_H = 158.0, 121.0
EDGE = 0.0
# Panel PCB measured off the module. It stands 8.5 mm up on J3 and covers its
# rectangle whole, so nothing taller than that may sit inside (KEHOACH 2.3A).
LCD_PANEL = (61.0, 107.0)
# 🔬 Hole centre to the panel edge, the one number left. The header row lands on the
# hole line a shade nearer the edge, so measuring this settles both (KEHOACH 2.3A).
LCD_HOLE_INSET = 3.5
LCD_HEADER_DROP = 1.0
LCD_HEADER_INSET = LCD_HOLE_INSET - LCD_HEADER_DROP
HOLE_FP = "MountingHole:MountingHole_3.2mm_M3"

# ref -> (x, y, rotation). A stock connector footprint has its origin on pin 1, so
# the point given is its top end; U1 is drawn in-house and placed by its centre.
PLACEMENT = {
    # Every module body along the top of the board starts on the panel's own top
    # edge, so the three outlines read as one line (KEHOACH 2.3I).
    "J4": (15.65, 20.0, 90),
    # Between the left row's names clearing the board edge and C4's can still fitting.
    "U1": (20.0, 64.0, 0),
    # Low enough that the panel's far edge clears the top of the board, since the
    # panel reaches 107 mm up from wherever its header lands.
    "J3": (55.54, 111.5, 90),
    # A 107 mm panel leaves no strip under itself, so its capacitor goes beside it,
    # centred in the gap and with its plus leg on the same line as the panel's VCC.
    "C4": (37.90, 111.5, 90),
    # Sockets under a module sit centred across its outline (KEHOACH 2.3I).
    # Right of the panel, three bands. Band 1, y 6..54: the I2C parts.
    "J13": (130.85, 34.32, 180),
    "J5": (114.04, 10.0, 90),
    "J6": (139.85, 12.0, 90),
    # Turned round so the 3V3 leg meets J6.VCC and the SDA leg meets J6.SDA, the
    # only two pads on the board 2.54 mm apart carrying those nets. Centred on J6.
    "R1": (151.28, 20.0, 180),
    # Band 2, y 58..80: the two loads that switch, each with its capacitor beside
    # it. J7 sits at the left edge of the amplifier's outline so C2 can reach it.
    "J7": (113.85, 62.38, 0),
    "C2": (113.85, 86.38, 0),
    # The servo header takes the outer slot so its cable clears the board edge; its
    # reservoir turns round to keep the plus leg on the pin it holds up (rule 7).
    "C3": (141.25, 64.92, 180),
    "J9": (148.5, 62.38, 0),
    # Band 3, y 84..108: the supplies side by side so their grounds meet at one
    # point (rule 1), J11 right under J9 so rail 2 climbs on one straight run.
    "C1": (137.0, 94.0, 0),
    "J10": (137.0, 107.0, 0),
    "J11": (148.5, 107.0, 0),
    # The one stretch of bottom edge a USB plug can still reach (KEHOACH 2.5).
    "J15": (108.59, 107.5, 90),
    "J16": (111.13, 100.5, 90),
    "J17": (122.19, 107.5, 90),
    "J18": (124.73, 100.5, 90),
}


def lcd_area() -> tuple:
    """The panel rectangle, anchored on the header it plugs into rather than guessed."""
    x, y, _ = PLACEMENT["J3"]
    centre = x + (14 - 1) * 2.54 / 2.0
    near = y + LCD_HEADER_INSET
    return (round(centre - LCD_PANEL[0] / 2, 2), round(near - LCD_PANEL[1], 2),
            round(centre + LCD_PANEL[0] / 2, 2), round(near, 2))


LCD_AREA = lcd_area()


def sd_row() -> tuple:
    """Under the panel's microSD pins, so one soldered there passes through."""
    x0, y0, x1, _ = LCD_AREA
    return (round((x0 + x1) / 2.0 - (4 - 1) * 2.54 / 2.0, 2),
            round(y0 + LCD_HEADER_INSET, 2), 90)


# 🔬 Assumed centred on the far edge, mirroring the header at the near one.
PLACEMENT["J14"] = sd_row()
# Where the carrier bolts to the case: H1..H4 hold the panel to this board, not this
# board to anything. The ToF and the terminals each moved 2 mm to clear a corner.
BOARD_HOLES = {"H5": (5.0, 5.0, 0), "H6": (153.0, 5.0, 0),
               "H7": (153.0, 116.0, 0), "H8": (5.0, 116.0, 0)}
PLACEMENT.update(BOARD_HOLES)
# A plugged-in module keeps its body, and that body lands on the board. Drawn on the
# silkscreen so nothing sits inside one. 🔬 ToF, expander and amplifier come off photos.
MODULE_AREA = {
    "J3 LCD 4.0in": LCD_AREA,
    "J4 VL53L1X": (9.5, 7.0, 34.5, 22.0),
    "J5 PCF8574 48x16": (109.85, 7.0, 125.85, 55.0),
    "J7 MAX98357A": (109.85, 60.0, 129.85, 80.0),
    "J15 USB-C": (105.9, 104.0, 118.9, 119.0),
    "J17 microUSB": (119.5, 104.0, 132.5, 119.0),
}


def lcd_holes() -> dict:
    """M3 clearance at the panel's four corners, so J3 carries no load."""
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
            # Modulo 180, the way KiCad's own boards store it: a name follows a
            # quarter turn but never ends up upside down at a half one.
            if rot:
                node = [([c[0], c[1], c[2], str((float(c[3] if len(c) > 3 else 0) + rot) % 180)]
                         if isinstance(c, list) and c[0] == "at" else c) for c in node]
        if node[0] == "pad":
            number = unquote(node[1])
            net = pin_nets.get(number)
            node = list(node)
            # A pad carries the footprint's angle even when it is round: the library
            # parity check reads pad orientation, and a bare (at x y) fails against it.
            if rot:
                node = [([c[0], c[1], c[2],
                          f"{(float(c[3] if len(c) > 3 else 0) + rot) % 360:g}"]
                         if isinstance(c, list) and c[0] == "at" else c) for c in node]
            if net:
                node.append(["net", str(net_id[net]), f'"{net}"'])
        if (node[0] == "property" and unquote(node[1]) == "Reference"
                and "MountingHole" in spec):
            node = list(node) + [["hide", "yes"]]
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
RAIL2_GROUND = {"J11.2", "J9.1", "C3.2", "J18.2"}
GROUND_TIE = ("J10.2", "J11.2")
# Rule 6: a supply rail is drawn, not searched. Each load reaches its own terminal on
# its own copper, and each reservoir hangs on the load it holds up (KEHOACH 2.5).
RAIL_TREE = {
    "+5V_R1": [("J10.1", "U1.20"), ("J10.1", "J7.7"), ("J10.1", "C1.1"), ("J7.7", "C2.1"),
               ("J10.1", "J16.1")],
    "+5V_R2": [("J11.1", "J9.2"), ("J9.2", "C3.1"), ("J11.1", "J18.1")],
}


LABEL_GAP = 0.6
LABEL_OFFSET = 1.5


def label_side(seats: dict) -> tuple:
    """Which way a row's names run and the line they start from, clear of any body."""
    xs = [s[0] for s in seats.values()]
    ys = [s[1] for s in seats.values()]
    across = (max(xs) - min(xs)) >= (max(ys) - min(ys))
    low, high = (min(ys), max(ys)) if across else (min(xs), max(xs))
    over = next((a for a in MODULE_AREA.values()
                 if a[0] <= min(xs) and max(xs) <= a[2]
                 and a[1] <= min(ys) and max(ys) <= a[3]), None)
    if over is None:
        return (across, 1, high + LABEL_OFFSET) if across else (across, -1, low - LABEL_OFFSET)
    near, far = (over[1], over[3]) if across else (over[0], over[2])
    if low - near <= far - high:
        return across, -1, near - LABEL_GAP
    return across, 1, far + LABEL_GAP


def pad_seats(fp: list) -> dict:
    """Pad number -> its board position, plus the local x that says which row it is on."""
    import math
    at = first(fp, "at")
    ox, oy = float(at[1]), float(at[2])
    th = math.radians(float(at[3]) if len(at) > 3 else 0.0)
    seats = {}
    for pad in children(fp, "pad"):
        a = first(pad, "at")
        lx, ly = float(a[1]), float(a[2])
        seats[unquote(pad[1])] = (ox + lx * math.cos(th) + ly * math.sin(th),
                                  oy - lx * math.sin(th) + ly * math.cos(th), lx)
    return seats


def move_references(doc: list) -> None:
    """A designator under a module is as lost as a pin name, so it follows them out."""
    import math
    import gen_sch
    labelled = {ref for ref, value, left, right, x, y in gen_sch.PARTS}
    for fp in [n for n in doc if isinstance(n, list) and n[0] == "footprint"]:
        prop = next((p for p in children(fp, "property")
                     if unquote(p[1]) == "Reference"), None)
        seats = pad_seats(fp)
        if prop is None or not seats or children(prop, "hide"):
            continue
        if unquote(prop[2]) not in labelled:
            continue
        xs = [s[0] for s in seats.values()]
        ys = [s[1] for s in seats.values()]
        if not any(a[0] <= min(xs) and max(xs) <= a[2]
                   and a[1] <= min(ys) and max(ys) <= a[3] for a in MODULE_AREA.values()):
            continue
        across, sign, line = label_side(seats)
        start = (min(xs) if across else min(ys)) - 3.0
        bx, by = (start, line + sign * 1.5) if across else (line + sign * 1.5, start)
        at = first(fp, "at")
        ox, oy = float(at[1]), float(at[2])
        th = math.radians(float(at[3]) if len(at) > 3 else 0.0)
        dx, dy = bx - ox, by - oy
        spot = first(prop, "at")
        spot[1] = f"{dx * math.cos(th) - dy * math.sin(th):.2f}"
        spot[2] = f"{dx * math.sin(th) + dy * math.cos(th):.2f}"


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
        seats = pad_seats(fp)
        across, sign, line = label_side(seats)
        for pad in pads:
            number = unquote(pad[1])
            label = names.get((ref, number))
            if not label:
                continue
            px, py, lx = seats[number]
            # Between the two rows is exactly where the devkit's body lands, so a label
            # put there is legible until the moment the board is actually used.
            if ref == "U1":
                ax, ay = px + (-2.0 if lx < 0 else 2.0), py
                rot, just = 0, ("right" if lx < 0 else "left")
            elif len(pads) == 2:
                # Beside its pad a label reaches the next part once two sit close, so
                # it goes above instead, nudged outward off the centred reference.
                away = -1.0 if px <= sum(s[0] for s in seats.values()) / 2 else 1.0
                ax, ay = px + 1.5 * away, py - 6.0
                rot, just = 0, None
            elif across:
                ax, ay = px, line
                rot, just = 90, ("right" if sign > 0 else "left")
            else:
                ax, ay = line, py
                rot, just = 0, ("right" if sign < 0 else "left")
            effects = ["effects", ["font", ["size", "0.8", "0.8"], ["thickness", "0.12"]]]
            if just:
                effects.append(["justify", just])
            out.append(["gr_text", f'"{label}"',
                        ["at", f"{ax:.2f}", f"{ay:.2f}", str(rot)],
                        ["layer", '"F.SilkS"'],
                        ["uuid", f'"{uid("lbl", ref, label)}"'], effects])
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
        if ref in BOARD_HOLES:
            continue
        doc.append(place(ref, footprint[ref], nets[ref], net_id, spot))
    for ref, spot in lcd_holes().items():
        doc.append(place(ref, HOLE_FP, {}, net_id, spot))
    for ref in BOARD_HOLES:
        doc.append(place(ref, HOLE_FP, {}, net_id, PLACEMENT[ref]))

    doc += pin_labels(doc)
    move_references(doc)
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
        seat = {q[0]: q for q in group}
        edges = ([(seat[a], seat[b]) for a, b in RAIL_TREE[name]] if name in RAIL_TREE
                 else spanning_edges(group))
        for j, (a, b) in enumerate(edges):
            doc += route(f"{name}{j}", a, b, width, layer, number)
            laid += 1

    OUT.write_text(emit(doc) + "\n", encoding="utf-8")
    print(f"{OUT}: {len(PLACEMENT)} footprint, {len(net_id)} net, board {BOARD_W}x{BOARD_H} mm")
    missing = sorted(set(footprint) - set(PLACEMENT))
    if missing:
        print(f"  !! chua dat: {missing}")


if __name__ == "__main__":
    main()
