"""Emit the ESP32-S3-CAM socket footprint: 2x20, 2.54 mm pitch, 25.4 mm between rows."""

import hashlib
from pathlib import Path

OUT = Path("hardware/lib/footprints/kiosk.pretty/ESP32-S3-CAM_2x20_P2.54mm_R25.4mm.kicad_mod")
# The string KiCad 10 itself wrote into kiosk.kicad_sch, so it cannot read as too new.
VERSION = "20260306"
ROWS, PITCH, ROW_GAP = 20, 2.54, 25.4
DRILL, PAD = 1.0, 1.7
HALF = (ROWS - 1) * PITCH / 2.0
X = ROW_GAP / 2.0
# Pads are exact, the outline is not: with no datasheet the module edge is
# over-stated on purpose, so nothing tall lands under the overhang. 🔬
CX, CY = 16.0, 33.0
USB_EDGE = 6.0


def uid(*parts: object) -> str:
    h = hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()
    return f"{h[:8]}-{h[8:12]}-4{h[13:16]}-8{h[17:20]}-{h[20:32]}"


def prop(name: str, value: str, y: float, layer: str, hide: bool = False) -> str:
    rows = [
        f'\t(property "{name}" "{value}"',
        f'\t\t(at 0 {y:.2f} 0)',
        f'\t\t(layer "{layer}")',
        *(["\t\t(hide yes)"] if hide else []),
        f'\t\t(uuid "{uid("prop", name)}")',
        "\t\t(effects",
        "\t\t\t(font",
        "\t\t\t\t(size 1 1)",
        "\t\t\t\t(thickness 0.15)",
        "\t\t\t)",
        "\t\t)",
        "\t)",
    ]
    return "\n".join(rows)


def line(tag: str, x1: float, y1: float, x2: float, y2: float, layer: str, w: float) -> str:
    return "\n".join([
        "\t(fp_line",
        f"\t\t(start {x1:.2f} {y1:.2f})",
        f"\t\t(end {x2:.2f} {y2:.2f})",
        f"\t\t(stroke\n\t\t\t(width {w})\n\t\t\t(type solid)\n\t\t)",
        f'\t\t(layer "{layer}")',
        f'\t\t(uuid "{uid("line", tag)}")',
        "\t)",
    ])


def pad(number: int, x: float, y: float) -> str:
    shape = "rect" if number == 1 else "circle"
    return "\n".join([
        f'\t(pad "{number}" thru_hole {shape}',
        f"\t\t(at {x} {y:.2f})",
        f"\t\t(size {PAD} {PAD})",
        f"\t\t(drill {DRILL})",
        '\t\t(layers "*.Cu" "*.Mask")',
        f'\t\t(uuid "{uid("pad", number)}")',
        "\t)",
    ])


def main() -> None:
    out = [
        '(footprint "ESP32-S3-CAM_2x20_P2.54mm_R25.4mm"',
        f"\t(version {VERSION})",
        '\t(generator "kiosk-gen")',
        '\t(generator_version "10.0")',
        '\t(layer "F.Cu")',
        '\t(descr "GOOUUU ESP32-S3-CAM socket, 2x20 at 2.54 mm, rows 25.4 mm apart - measured '
        'on the board and confirmed against a published figure. Pin 1 = 3V3 at top left seen '
        'from above with the two USB-C on the bottom edge; the silkscreen bar marks that edge. '
        'The outline is deliberately oversized: this board has no datasheet, so its real edge '
        'is unmeasured and the courtyard errs wide to keep tall parts out from under it. Keep '
        'the USB edge clear for cables, and EN and BOOT reachable on the top face.")',
        '\t(tags "esp32s3 cam devkit socket")',
        "\t(attr through_hole)",
        prop("Reference", "REF**", -CY - 1.5, "F.SilkS"),
        prop("Value", "ESP32-S3-CAM", CY + 1.5, "F.Fab"),
    ]
    for layer, width, grow in (("F.SilkS", 0.12, 0.0), ("F.CrtYd", 0.05, 0.25)):
        x, y = CX + grow, CY + grow
        for tag, a, b, c, d in (("t", -x, -y, x, -y), ("r", x, -y, x, y),
                                ("b", x, y, -x, y), ("l", -x, y, -x, -y)):
            out.append(line(f"{layer}{tag}", a, b, c, d, layer, width))
    out.append(line("usb", -CX, CY - USB_EDGE, CX, CY - USB_EDGE, "F.SilkS", 0.12))

    for i in range(ROWS):
        out.append(pad(i + 1, -X, -HALF + i * PITCH))
    for i in range(ROWS):
        out.append(pad(ROWS + i + 1, X, -HALF + i * PITCH))
    out.append(")")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"{OUT}")
    print(f"  {ROWS * 2} chan | hang cach {ROW_GAP} mm | chan 1 tai ({-X}, {-HALF:.2f})")
    print(f"  courtyard {2 * (CX + 0.25):.1f} x {2 * (CY + 0.25):.1f} mm")


if __name__ == "__main__":
    main()
