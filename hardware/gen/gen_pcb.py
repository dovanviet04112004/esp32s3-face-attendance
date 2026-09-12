"""Emit hardware/kicad/kiosk.kicad_pcb: footprints placed, nets attached, outline cut.

Placement follows the five ground rules of KE HOACH section 2.5, so the two
supplies sit side by side with one tie between them, each heavy load returns to
its own terminal, and the amplifier keeps its distance from the I2C bus.
"""

import hashlib
import math
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
# Hole centre to hole centre across the panel, measured on it. The two insets that
# follow are not equal, and the header row sits 1 mm outside the near one (KEHOACH 2.3A).
LCD_HOLE_PITCH = (55.0, 102.0)
LCD_HOLE_INSET = ((LCD_PANEL[0] - LCD_HOLE_PITCH[0]) / 2,
                  (LCD_PANEL[1] - LCD_HOLE_PITCH[1]) / 2)
LCD_HEADER_DROP = 1.0
LCD_HEADER_INSET = LCD_HOLE_INSET[1] - LCD_HEADER_DROP
# The two rows measure 104 mm apart on the panel, which puts the far one the same
# 1.5 mm in as the near one - the mirror section 2.3A assumed, now read off it.
LCD_SD_INSET = LCD_HEADER_INSET
HOLE_FP = "MountingHole:MountingHole_3.2mm_M3"

# ref -> (x, y, rotation). A stock connector footprint has its origin on pin 1, so the
# point given is its top end; every in-house one is placed by its centre instead.
PLACEMENT = {
    # Every module body along the top of the board starts on the panel's own top
    # edge, so the three outlines read as one line (KEHOACH 2.3I).
    "J4": (15.65, 20.0, 90),
    # Between the left row's names clearing the board edge and C4's can still fitting.
    "U1": (20.0, 64.0, 0),
    # Low enough that the panel's far edge clears the top of the board, since the
    # panel reaches 107 mm up from wherever its header lands.
    "J3": (55.54, 112.5, 90),
    # A 107 mm panel leaves no strip under itself, so its capacitor goes beside it,
    # centred in the gap and with its plus leg on the same line as the panel's VCC.
    "C4": (37.90, 112.5, 90),
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
    "J16": (111.13, 99.0, 90),
    "J18": (124.73, 99.0, 90),
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
    return (round((x0 + x1) / 2.0, 2), round(y0 + LCD_SD_INSET, 2), 90)


PLACEMENT["J14"] = sd_row()
# Where the carrier bolts to the case: H1..H4 hold the panel to this board, not this
# board to anything. The ToF and the terminals each moved 2 mm to clear a corner.
BOARD_HOLES = {"H5": (5.0, 5.0, 0), "H6": (153.0, 5.0, 0),
               "H7": (153.0, 116.0, 0), "H8": (5.0, 116.0, 0)}
PLACEMENT.update(BOARD_HOLES)
# Bare holes carrying no net, so like the screw holes they never reach the sheet.
GRID_FP = "kiosk:SolderGrid_4x05_P2.54mm"
SOLDER_GRID = {"J15": (112.4, 111.5, 0), "J17": (126.0, 111.5, 0)}
PLACEMENT.update(SOLDER_GRID)
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
    wide, tall = LCD_HOLE_INSET
    corners = ((x0 + wide, y0 + tall), (x1 - wide, y0 + tall),
               (x1 - wide, y1 - tall), (x0 + wide, y1 - tall))
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


# pcb upgrade mints a random uuid for every one of these that arrives without one, so
# each is named here, keyed on the reference to stay unique across two placements.
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
            node = [c for c in node if not (isinstance(c, list) and c[0] == "uuid")]
            seen[node[0]] = seen.get(node[0], 0) + 1
            node.append(["uuid", f'"{uid("in", ref, node[0], seen[node[0]])}"'])
        out.append(node)
    return out


# Track widths and clearances are the two classes of kiosk.kicad_pro: section 2.5 puts
# 1.34 A of peak on rail 1 and 0.7 A on rail 2, and 0.25 mm does not carry that.
ROUTE = True
POWER_MM, SIGNAL_MM = 1.0, 0.25
POWER_CLEAR, SIGNAL_CLEAR = 0.35, 0.25
# Every pad is through-hole, so either side reaches it and a whole run may sit on the
# back with no via. Supplies prefer the back and signals the front; crossing costs one.
POWER_LAYER, SIGNAL_LAYER = '"B.Cu"', '"F.Cu"'
LAYERS = (SIGNAL_LAYER, POWER_LAYER)
# A power via carries a load's whole return, so it is drilled wider than a
# signal one: IPC-2221 gives a 0.4 mm barrel 1.11 A and a 0.6 mm barrel 1.48 A.
VIA = {SIGNAL_MM: (0.8, 0.4), POWER_MM: (1.2, 0.6)}
PROBES = (SIGNAL_MM / 2, POWER_MM / 2, 0.4, 0.6)
GRID = 0.2
EDGE_KEEP = 0.4
# An M3 washer is Ø7.0 and presses on the mask, not on the hole edge DRC measures.
SCREW_KEEP = 3.5
TURN_COST, VIA_COST, WRONG_SIDE = 6, 30, 1
NX = int(BOARD_W / GRID) + 1
NY = int(BOARD_H / GRID) + 1

# Rule 1 of section 2.5: the two grounds meet at exactly one point. They are laid as
# two nets that block each other, so no second junction can appear by accident.
RAIL2_GROUND = {"J11.2", "J9.1", "C3.2", "J18.2"}
GROUND_TIE = ("J10.2", "J11.2")
# Rules 2, 6 and 7: a rail is drawn, not searched. Each heavy load reaches its own
# terminal on its own copper, and each reservoir hangs on the load it holds up.
RAIL_TREE = {
    "+5V_R1": [("J10.1", "U1.20"), ("J10.1", "J7.7"), ("J10.1", "C1.1"), ("J7.7", "C2.1"),
               ("J10.1", "J16.1")],
    "+5V_R2": [("J11.1", "J9.2"), ("J9.2", "C3.1"), ("J11.1", "J18.1")],
    "GND@tie": [GROUND_TIE],
    # Four branches leave J10.2, which has the room; every pad wedged in a row carries
    # at most two, because its neighbours leave it only the two ways out.
    "GND@1": [("J10.2", "J7.6"), ("J7.6", "C2.2"), ("J10.2", "C1.2"), ("J10.2", "U1.40"),
              ("J10.2", "J16.2"), ("U1.40", "C4.2"), ("C4.2", "J3.2"), ("J3.2", "J4.2"),
              ("J4.2", "J5.3"), ("J5.3", "J6.6")],
    "GND@2": [("J11.2", "J9.1"), ("J9.1", "C3.2"), ("J11.2", "J18.2")],
}


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


def via(tag: str, at: tuple, width: float, net: int) -> list:
    size, drill = VIA[width]
    # Mask covers every via: a module standing over one cannot reach it, and silk
    # printed across one keeps its letters (KEHOACH 2.5).
    return ["via", ["at", str(at[0]), str(at[1])], ["size", str(size)],
            ["drill", str(drill)], ["layers", SIGNAL_LAYER, POWER_LAYER],
            ["covering", ["front", "yes"], ["back", "yes"]],
            ["net", str(net)], ["uuid", f'"{uid("via", tag)}"']]


def every_pad(doc: list) -> dict:
    """Pad id -> x, y, half its widest side, and the net it carries or None."""
    found = {}
    for fp in [n for n in doc if isinstance(n, list) and n[0] == "footprint"]:
        ref = next((unquote(p[2]) for p in children(fp, "property")
                    if len(p) > 2 and unquote(p[1]) == "Reference"), "?")
        at = first(fp, "at")
        ox, oy = float(at[1]), float(at[2])
        th = math.radians(float(at[3]) if len(at) > 3 else 0.0)
        for pad in children(fp, "pad"):
            a, size, net = first(pad, "at"), first(pad, "size"), first(pad, "net")
            lx, ly = float(a[1]), float(a[2])
            wide, tall = float(size[1]), float(size[2])
            # A square pad reaches further at its corners than any circle drawn on its
            # side does, and pin 1 of every header is square.
            reach = (math.hypot(wide, tall) if pad[3] in ("rect", "roundrect")
                     else max(wide, tall)) / 2.0
            found[f"{ref}.{unquote(pad[1])}"] = (
                round(ox + lx * math.cos(th) + ly * math.sin(th), 3),
                round(oy - lx * math.sin(th) + ly * math.cos(th), 3),
                reach, unquote(net[-1]) if net else None)
    return found


def pad_tag(pad_id: str, net: str) -> str:
    """Which routing net a pad belongs to; ground splits in two before it is laid."""
    if net != "GND":
        return net
    return "GND@2" if pad_id in RAIL2_GROUND else "GND@1"


def net_clear(net: str) -> float:
    """A pad answers to its own class too, and KiCad keeps the wider of the two."""
    return POWER_CLEAR if net and (net[0] == "+" or net == "GND") else SIGNAL_CLEAR


def wire_class(tag: str) -> tuple:
    if tag[0] == "+" or tag.startswith("GND"):
        return POWER_MM, POWER_CLEAR, POWER_LAYER
    return SIGNAL_MM, SIGNAL_CLEAR, SIGNAL_LAYER


def disc_cells(x: float, y: float, r: float) -> list:
    out = []
    for i in range(max(0, int((x - r) / GRID)), min(NX - 1, int((x + r) / GRID) + 1) + 1):
        room = r * r - (i * GRID - x) ** 2
        if room < 0:
            continue
        span = math.sqrt(room)
        for j in range(max(0, math.ceil((y - span) / GRID)),
                       min(NY - 1, int((y + span) / GRID)) + 1):
            out.append(j * NX + i)
    return out


def line_cells(a: tuple, b: tuple, r: float) -> set:
    out = set()
    steps = max(1, int(math.dist(a, b) / (GRID / 2)))
    for k in range(steps + 1):
        t = k / steps
        out.update(disc_cells(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, r))
    return out


def border(width: float) -> set:
    keep = width / 2.0 + EDGE_KEEP
    lo_i, hi_i = math.ceil(keep / GRID), int((BOARD_W - keep) / GRID)
    lo_j, hi_j = math.ceil(keep / GRID), int((BOARD_H - keep) / GRID)
    out = set()
    for j in range(NY):
        if j < lo_j or j > hi_j:
            out.update(range(j * NX, (j + 1) * NX))
        else:
            out.update(range(j * NX, j * NX + lo_i))
            out.update(range(j * NX + hi_i + 1, (j + 1) * NX))
    return out


def screw_keepout(probe: float) -> set:
    """Cells no copper may reach: the screw head and standoff press here (KEHOACH 2.5)."""
    holes = list(lcd_holes().values()) + [PLACEMENT[ref] for ref in BOARD_HOLES]
    return {cell for x, y, _ in holes for cell in disc_cells(x, y, SCREW_KEEP + probe)}


def find_path(blocked: dict, room: dict, start: tuple, goal: tuple, want: str) -> list:
    """(cell, layer) from pad to pad over both sides; a layer change is a via."""
    import heapq
    si, sj = int(round(start[0] / GRID)), int(round(start[1] / GRID))
    gi, gj = int(round(goal[0] / GRID)), int(round(goal[1] / GRID))
    src, dst = sj * NX + si, gj * NX + gi
    step = ((1, 0), (0, 1), (-1, 0), (0, -1))
    side = {name: k for k, name in enumerate(LAYERS)}
    wall = [blocked[name] for name in LAYERS]
    hole = [room[name] for name in LAYERS]
    bias = [0 if name == want else WRONG_SIDE for name in LAYERS]
    best, came, heap = {}, {}, []
    for lay in range(2):
        if wall[lay][src]:
            continue
        for d in range(4):
            state = (src * 4 + d) * 2 + lay
            best[state] = 0
            heap.append((abs(si - gi) + abs(sj - gj), 0, state))
    heapq.heapify(heap)
    while heap:
        _, cost, state = heapq.heappop(heap)
        if cost > best.get(state, 1 << 30):
            continue
        seat, lay = divmod(state, 2)
        cell, face = divmod(seat, 4)
        if cell == dst:
            trail = []
            while True:
                trail.append((state // 8, state % 2))
                if state not in came:
                    return trail[::-1]
                state = came[state]
        i, j = cell % NX, cell // NX
        moves = []
        if not (hole[0][cell] or hole[1][cell]):
            moves.append(((cell * 4 + face) * 2 + (1 - lay), VIA_COST))
        for turn, (dx, dy) in enumerate(step):
            ni, nj = i + dx, j + dy
            if 0 <= ni < NX and 0 <= nj < NY and not wall[lay][nj * NX + ni]:
                moves.append((((nj * NX + ni) * 4 + turn) * 2 + lay,
                              1 + bias[lay] + (0 if turn == face else TURN_COST)))
        for ahead, price in moves:
            if wall[ahead % 2][ahead // 8]:
                continue
            walk = cost + price
            if walk < best.get(ahead, 1 << 30):
                best[ahead] = walk
                came[ahead] = state
                ni, nj = (ahead // 8) % NX, (ahead // 8) // NX
                heapq.heappush(heap, (walk + abs(ni - gi) + abs(nj - gj), walk, ahead))
    return None


def corners(cells: list) -> list:
    pts = [((c % NX) * GRID, (c // NX) * GRID) for c in cells]
    out = [pts[0]]
    for k in range(1, len(pts) - 1):
        ax, ay = pts[k - 1]
        bx, by = pts[k]
        cx, cy = pts[k + 1]
        if (round(bx - ax, 4), round(by - ay, 4)) != (round(cx - bx, 4), round(cy - by, 4)):
            out.append((bx, by))
    out.append(pts[-1])
    return out


def turn(x: float, y: float, deg: float, lx: float, ly: float) -> tuple:
    th = math.radians(deg)
    return (x + lx * math.cos(th) + ly * math.sin(th),
            y - lx * math.sin(th) + ly * math.cos(th))


# Glyph figures are check_pcb's, kept here so the router can dodge what it measures.
GLYPH_MM, REF_GLYPH_MM, LINE_MM = 0.62, 0.78, 1.0
# Both floors a fab publishes for silkscreen: 0.8 mm tall, 0.15 mm pen (KEHOACH 2.3).
SILK_MM, SILK_PEN_MM = "0.8", "0.15"


def silk_cells(doc: list) -> set:
    """Cells under a printed name: silk is clipped off bare copper, so no via may sit there."""
    printed = [(n, unquote(n[1]), GLYPH_MM, 0.0, 0.0, 0.0)
               for n in doc if isinstance(n, list) and n[0] == "gr_text"]
    for fp in [n for n in doc if isinstance(n, list) and n[0] == "footprint"]:
        at = first(fp, "at")
        ox, oy = float(at[1]), float(at[2])
        deg = float(at[3]) if len(at) > 3 else 0.0
        for prop in children(fp, "property"):
            if unquote(prop[1]) != "Reference" or children(prop, "hide"):
                continue
            printed.append((prop, unquote(prop[2]), REF_GLYPH_MM, ox, oy, deg))
    out = set()
    for node, text, glyph, ox, oy, deg in printed:
        layer = first(node, "layer")
        if not layer or unquote(layer[1]) != "F.SilkS":
            continue
        at = first(node, "at")
        x, y = float(at[1]), float(at[2])
        rot = float(at[3]) if len(at) > 3 else 0.0
        if (ox, oy, deg) != (0.0, 0.0, 0.0):
            x, y = turn(ox, oy, deg, x, y)
            rot = 0.0
        justify = first(first(node, "effects") or [], "justify")
        side = unquote(justify[1]) if justify else "center"
        span = len(text) * glyph
        reach = {"left": (0.0, span), "right": (-span, 0.0),
                 "center": (-span / 2, span / 2)}[side]
        a = turn(x, y, rot, reach[0], -LINE_MM / 2)
        b = turn(x, y, rot, reach[1], LINE_MM / 2)
        grow = max(VIA[POWER_MM][0], VIA[SIGNAL_MM][0]) / 2
        for i in range(max(0, int((min(a[0], b[0]) - grow) / GRID)),
                       min(NX - 1, int((max(a[0], b[0]) + grow) / GRID)) + 1):
            for j in range(max(0, int((min(a[1], b[1]) - grow) / GRID)),
                           min(NY - 1, int((max(a[1], b[1]) + grow) / GRID)) + 1):
                out.add(j * NX + i)
    return out


def hug(pts: list, seat: tuple, head: bool) -> None:
    """Slide the leg that reaches a pad onto the pad's own axis: the grid rarely falls
    on a pad centre, and a track that bends to find it reads as crooked."""
    i, j = (1, 2) if head else (len(pts) - 2, len(pts) - 3)
    if not 0 <= j < len(pts) or not 0 <= i < len(pts):
        return
    (ax, ay), (bx, by) = pts[i], pts[j]
    if abs(ax - bx) < 1e-6:
        pts[i], pts[j] = (seat[0], ay), (seat[0], by)
    elif abs(ay - by) < 1e-6:
        pts[i], pts[j] = (ax, seat[1]), (bx, seat[1])


def straighten(pts: list) -> None:
    """Drop a corner that no longer turns: sliding a leg onto a pad axis can leave
    three points on one line, and each pair of them is emitted as its own track."""
    k = 1
    while k < len(pts) - 1:
        (ax, ay), (bx, by), (cx, cy) = pts[k - 1], pts[k], pts[k + 1]
        if abs((bx - ax) * (cy - by) - (by - ay) * (cx - bx)) < 1e-9:
            del pts[k]
        else:
            k += 1


def route_jobs(pads: dict) -> list:
    """Every edge to lay, in the order that decides which one gets first pick."""
    jobs = [(tag, a, b) for tag in RAIL_TREE for a, b in RAIL_TREE[tag]]
    rest: dict = {}
    for pad_id, (x, y, half, net) in pads.items():
        if net is None or net == "GND" or net in RAIL_TREE:
            continue
        rest.setdefault(net, []).append((pad_id, x, y))
    for net in sorted(rest, key=lambda n: (-len(rest[n]), n)):
        jobs += [(net, a[0], b[0]) for a, b in spanning_edges(rest[net])]
    return jobs


def one_run(pads: dict, stamp: dict, rim: dict, ink: set, placed: list,
            job: tuple) -> tuple:
    """Corners with the layer each sits on, or None when there is no way through."""
    tag, src, dst = job
    width, clear, want = wire_class(tag)
    blocked, room = {}, {}
    for probe, into in ((width / 2, blocked), (VIA[width][0] / 2, room)):
        for layer in LAYERS:
            field = bytearray(NX * NY)
            for cell in rim[probe]:
                field[cell] = 1
            for pad_id, (x, y, half, net) in pads.items():
                if pad_id in (src, dst) or (net and pad_tag(pad_id, net) == tag):
                    continue
                for cell in stamp[(max(clear, net_clear(net)), probe)][pad_id]:
                    field[cell] = 1
            if probe != width / 2:
                for cell in ink:
                    field[cell] = 1
            for run in placed:
                # A declared tree stays a tree: its own branches block each other, so
                # two loads never share copper the plan says they must not (rule 6).
                if run["tag"] == tag and tag not in RAIL_TREE:
                    continue
                for cell in run["halo"][layer][(clear, probe)]:
                    field[cell] = 1
            # Copper on the two pads an edge joins is shared by what else lands there.
            for pad_id in (src, dst):
                x, y, half, _ = pads[pad_id]
                for cell in disc_cells(x, y, half):
                    field[cell] = 0
            into[layer] = field
    trail = find_path(blocked, room, pads[src][:2], pads[dst][:2], want)
    if trail is None:
        return None
    runs, here = [], [trail[0]]
    for cell, lay in trail[1:]:
        if lay == here[-1][1]:
            here.append((cell, lay))
        else:
            runs.append(here)
            here = [(cell, lay)]
    runs.append(here)
    out = []
    for part in runs:
        pts = corners([c for c, _ in part])
        out.append((pts, LAYERS[part[0][1]]))
    out[0] = ([pads[src][:2]] + out[0][0], out[0][1])
    out[-1] = (out[-1][0] + [pads[dst][:2]], out[-1][1])
    hug(out[0][0], pads[src][:2], True)
    hug(out[-1][0], pads[dst][:2], False)
    for pts, _ in out:
        straighten(pts)
    return out


def route_board(doc: list, net_id: dict) -> list:
    """Lay every edge; when one is walled in, lift the newest foreign run and retry."""
    pads = every_pad(doc)
    probes = [(c, r) for c in (SIGNAL_CLEAR, POWER_CLEAR) for r in PROBES]
    stamp = {key: {pad_id: disc_cells(x, y, half + key[0] + key[1])
                   for pad_id, (x, y, half, net) in pads.items()} for key in probes}
    rim = {r: border(2 * r) | screw_keepout(r) for r in PROBES}
    # A via under a printed name eats the name: the fab clips silk off bare copper.
    ink = silk_cells(doc)
    queue, placed, tries = list(route_jobs(pads)), [], {}
    budget = 12 * len(queue)
    while queue:
        budget -= 1
        if budget < 0:
            raise SystemExit("!! rip-up khong hoi tu, dung lai")
        job = queue.pop(0)
        parts = one_run(pads, stamp, rim, ink, placed, job)
        if parts is not None:
            placed.append(settle(job, parts))
            continue
        tries[job] = tries.get(job, 0) + 1
        if tries[job] > 8:
            raise SystemExit(f"!! khong tim duoc duong {job[0]}: {job[1]} -> {job[2]}")
        victim = next((r for r in reversed(placed) if r["tag"] != job[0]), None)
        if victim is None:
            raise SystemExit(f"!! {job[0]}: {job[1]} -> {job[2]} bi chinh pad chan")
        placed.remove(victim)
        queue.insert(0, job)
        queue.append(victim["job"])

    out = []
    for order, run in enumerate(placed):
        number = net_id[run["tag"].split("@")[0]]
        for k, (a, b, layer) in enumerate(run["legs"]):
            out.append(track(f'{run["tag"]}-{order}-{k}', a, b, run["width"], layer, number))
        for k, at in enumerate(run["holes"]):
            out.append(via(f'{run["tag"]}-{order}-{k}', at, run["width"], number))
    return out


def settle(job: tuple, parts: list) -> dict:
    """One laid edge: its legs, its vias, and the copper each job must keep clear of."""
    tag = job[0]
    width, clear, _ = wire_class(tag)
    legs, holes = [], []
    for pts, layer in parts:
        for k in range(len(pts) - 1):
            if math.dist(pts[k], pts[k + 1]) > 1e-6:
                legs.append((pts[k], pts[k + 1], layer))
    for k in range(len(parts) - 1):
        holes.append(parts[k][0][-1])
    halo = {}
    for layer in LAYERS:
        halo[layer] = {}
        for job_clear in (SIGNAL_CLEAR, POWER_CLEAR):
            gap = max(clear, job_clear)
            for probe in PROBES:
                cells = set()
                for a, b, side in legs:
                    if side == layer:
                        cells |= line_cells(a, b, width / 2 + gap + probe)
                for at in holes:
                    cells.update(disc_cells(at[0], at[1], VIA[width][0] / 2 + gap + probe))
                halo[layer][(job_clear, probe)] = cells
    return {"job": job, "tag": tag, "width": width, "legs": legs,
            "holes": holes, "halo": halo}


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
            effects = ["effects", ["font", ["size", SILK_MM, SILK_MM],
                                   ["thickness", SILK_PEN_MM]]]
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
        if ref in BOARD_HOLES or ref in SOLDER_GRID:
            continue
        doc.append(place(ref, footprint[ref], nets[ref], net_id, spot))
    for ref, spot in lcd_holes().items():
        doc.append(place(ref, HOLE_FP, {}, net_id, spot))
    for ref in BOARD_HOLES:
        doc.append(place(ref, HOLE_FP, {}, net_id, PLACEMENT[ref]))
    for ref in SOLDER_GRID:
        doc.append(place(ref, GRID_FP, {}, net_id, PLACEMENT[ref]))

    doc += pin_labels(doc)
    move_references(doc)
    laid = route_board(doc, net_id) if ROUTE else []
    doc += laid

    OUT.write_text(emit(doc) + "\n", encoding="utf-8")
    print(f"{OUT}: {len(PLACEMENT)} footprint, {len(net_id)} net, {len(laid)} doan day, "
          f"board {BOARD_W}x{BOARD_H} mm")
    missing = sorted(set(footprint) - set(PLACEMENT))
    if missing:
        print(f"  !! chua dat: {missing}")


if __name__ == "__main__":
    main()
