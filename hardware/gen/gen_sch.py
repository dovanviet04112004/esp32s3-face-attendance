"""Emit hardware/kicad/kiosk.kicad_sch from the pin map of KE HOACH section 2."""

from __future__ import annotations

import hashlib
from pathlib import Path

OUT = Path("hardware/kicad/kiosk.kicad_sch")
SYMBOLS = Path("hardware/lib/symbols/kiosk.kicad_sym")
# A sheet and a symbol library are two formats on two version numbers.
SHEET_FORMAT, SYMBOL_FORMAT = 20260306, 20251024
ROOT_UUID = "b0a1c2d3-0000-4000-8000-000000000001"
PITCH = 2.54
STUB = 5.08


def uid(*parts: object) -> str:
    h = hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()
    return f"{h[:8]}-{h[8:12]}-4{h[13:16]}-8{h[17:20]}-{h[20:32]}"


# (label, net) per pin; net None leaves the pin unconnected.
DEVKIT_LEFT = [
    ("3V3", "+3V3"), ("EN", None),
    ("IO4", None), ("IO5", None), ("IO6", None), ("IO7", None), ("IO15", None),
    ("IO16", None), ("IO17", None), ("IO18", None), ("IO8", None),
    ("IO3", "TOF_INT"), ("IO46", "AUDIO_DIN"),
    ("IO9", None), ("IO10", None), ("IO11", None), ("IO12", None), ("IO13", None),
    ("IO14", "TOUCH_INT"), ("5V", "+5V_R1"),
]
DEVKIT_RIGHT = [
    ("IO43", "LCD_SDO"), ("IO44", "AUDIO_LRC"),
    ("IO1", "I2C_SDA"), ("IO2", "I2C_SCL"),
    ("IO42", "LCD_SCK"), ("IO41", "LCD_MOSI"),
    ("IO40", "LCD_RST"), ("IO39", "LCD_DC"), ("IO38", "SERVO_PWM"),
    ("IO37", None), ("IO36", None), ("IO35", None), ("IO0", None),
    ("IO45", "AUDIO_BCLK"), ("IO48", None),
    ("IO47", "LCD_CS"), ("IO21", "LCD_BLK"),
    ("IO20", None), ("IO19", None), ("GND", "GND"),
]

LCD = [
    ("VCC", "+3V3"), ("GND", "GND"), ("CS", "LCD_CS"), ("RESET", "LCD_RST"),
    ("D/C", "LCD_DC"), ("SDI", "LCD_MOSI"), ("SCK", "LCD_SCK"), ("LED", "LCD_BLK"),
    ("SDO", "LCD_SDO"), ("NC", None), ("CTP_SDA", "I2C_SDA"), ("CTP_SCL", "I2C_SCL"),
    ("CTP_INT", "TOUCH_INT"), ("CTP_RST", "TOUCH_RST"),
]
# Header order read off each module, not guessed. The ToF calls its interrupt
# GPIO1, which is the sensor's own name for it and nothing to do with ESP GPIO1.
TOF = [("VIN", "+3V3"), ("GND", "GND"), ("SCL", "I2C_SCL"), ("SDA", "I2C_SDA"),
       ("GPIO1", "TOF_INT"), ("XSHUT", "TOF_XSHUT")]
# Two rows on the module and they are perpendicular, so two sockets. A0/A1/A2 are
# solder pads on the module itself, not pins, so no copper on the carrier reaches them.
EXPANDER_I2C = [("SCL", "I2C_SCL"), ("SDA", "I2C_SDA"), ("GND", "GND"), ("VCC", "+3V3")]
# Nine holes for a nine-pin port row though only P0/P1/P3 take a wire, so a later
# signal reaches the row without cutting the board (KEHOACH 2.3I).
EXPANDER_IO = [("P0", "TOUCH_RST"), ("P1", "TOF_XSHUT"), ("P2", None), ("P3", "AMP_SD"),
               ("P4", None), ("P5", None), ("P6", None), ("P7", None), ("INT", None)]
# The panel's own microSD row, landed as bare holes and wired to nothing: SD_CS has
# no GPIO left to reach and the other three would share SPI2 (KEHOACH 2.3A).
SD = [("SD_CS", None), ("SD_MOSI", None), ("SD_MISO", None), ("SD_SCK", None)]
RTC = [("32K", None), ("SQW", None), ("SCL", "I2C_SCL"), ("SDA", "I2C_SDA"),
       ("VCC", "+3V3"), ("GND", "GND")]
# The speaker lands on the amplifier module's own screw terminal, so OUT+ and OUT-
# never reach the carrier and the carrier carries no speaker connector.
AMP = [("LRC", "AUDIO_LRC"), ("BCLK", "AUDIO_BCLK"), ("DIN", "AUDIO_DIN"),
       ("GAIN", None), ("SD", "AMP_SD"), ("GND", "GND"), ("VIN", "+5V_R1")]
# Plug order on an SG90; reversed, the servo's ground lands on the pin GPIO38
# is driving, because ground and signal sit at the two ends (KEHOACH 2.3F).
SERVO = [("GND", "GND"), ("VCC", "+5V_R2"), ("PWM", "SERVO_PWM")]
JACK1 = [("+5V", "+5V_R1"), ("GND", "GND")]
JACK2 = [("+5V", "+5V_R2"), ("GND", "GND")]
TAP1 = [("+5V", "+5V_R1"), ("GND", "GND")]
TAP2 = [("+5V", "+5V_R2"), ("GND", "GND")]

# ref, value, pins for the left bank, pins for the right bank, x, y. Three columns: the
# devkit with the two USB taps under it, everything quiet, everything that moves current.
PARTS = [
    ("U1", "ESP32-S3-CAM N16R8", DEVKIT_LEFT, DEVKIT_RIGHT, 48.0, 105.0),
    ("J16", "USB-C - hai lo nguon ve rail 1", TAP1, [], 48.0, 180.34),
    ("J18", "microUSB - hai lo nguon ve rail 2", TAP2, [], 48.0, 207.01),
    ("J3", "LCD 4.0in ST7796S + GT911", LCD, [], 112.0, 48.26),
    ("J14", "LCD microSD - lo cho, chua noi day", SD, [], 112.0, 90.17),
    ("J4", "VL53L1X", TOF, [], 112.0, 121.92),
    ("J5", "PCF8574 - de cam 4 chan nguon", EXPANDER_I2C, [], 112.0, 153.67),
    ("J13", "PCF8574 - han day tu hang P", EXPANDER_IO, [], 112.0, 189.23),
    ("J6", "DS3231", RTC, [], 112.0, 227.33),
    ("J7", "MAX98357A", AMP, [], 182.0, 39.37),
    ("J9", "SG90 servo", SERVO, [], 182.0, 102.87),
    ("J10", "Jack 5V rail 1", JACK1, [], 182.0, 160.02),
    ("J11", "Jack 5V rail 2", JACK2, [], 182.0, 215.9),
]

# ref, value, top net, bottom net, x, y. Each one is drawn beside the load it holds
# up, so the sheet says which rail it belongs to without reading a net label.
TWO_PIN = [
    ("R1", "4k7", "+3V3", "I2C_SDA", 132.0, 153.67),
    ("C1", "1000uF", "+5V_R1", "GND", 182.0, 187.96),
    ("C2", "470uF", "+5V_R1", "GND", 182.0, 73.66),
    ("C3", "470uF", "+5V_R2", "GND", 182.0, 132.08),
    ("C4", "100uF", "+3V3", "GND", 132.0, 48.26),
]

FONT = "(effects (font (size 1.27 1.27)))"

SOCKET = "Connector_PinSocket_2.54mm:PinSocket_1x{:02d}_P2.54mm_Vertical"
HEADER = "Connector_PinHeader_2.54mm:PinHeader_1x{:02d}_P2.54mm_Vertical"
TERMINAL = "TerminalBlock:TerminalBlock_MaiXu_MX126-5.0-02P_1x02_P5.00mm"

FOOTPRINTS = {
    "U1": "kiosk:ESP32-S3-CAM_2x20_P2.54mm_R25.4mm",
    # Modules drop into these, so they are sockets.
    "J3": SOCKET.format(14), "J4": SOCKET.format(6), "J5": SOCKET.format(4),
    "J13": HEADER.format(9), "J6": SOCKET.format(6), "J7": SOCKET.format(7),
    # Holes, not a socket: a second socket 104 mm from J3 would have to line up with it.
    "J14": "kiosk:BareHoles_1x04_P2.54mm",
    # The servo arrives with a female plug and the spare row takes jumper wires.
    "J9": HEADER.format(3),
    # Both supplies are screw terminals: they carry the peak amps of section 2.5.
    "J10": TERMINAL, "J11": TERMINAL,
    "J16": HEADER.format(2), "J18": HEADER.format(2),
    "R1": "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal",
    "C1": "Capacitor_THT:CP_Radial_D10.0mm_P5.00mm",
    "C2": "Capacitor_THT:CP_Radial_D8.0mm_P3.50mm",
    "C3": "Capacitor_THT:CP_Radial_D8.0mm_P3.50mm",
    # Same 2.50 mm holes as the 6.3 mm can, but the panel leaves a 7.30 mm gap
    # and only a 5 mm body clears it either side (KEHOACH 2.5).
    "C4": "Capacitor_THT:CP_Radial_D5.0mm_P2.50mm",
}


def sym_pin(name: str, number: int, x: float, y: float, angle: int) -> str:
    return (f'        (pin passive line (at {x} {y} {angle}) (length {STUB})\n'
            f'          (name "{name}" {FONT})\n'
            f'          (number "{number}" {FONT})\n'
            f'        )')


def lib_symbol(ref: str, left: list, right: list) -> str:
    rows = max(len(left), len(right))
    half = (rows - 1) * PITCH / 2.0
    body = 12.7 if right else 10.16
    out = [f'    (symbol "kiosk:{ref}" (pin_names (offset 0.508))',
           '      (exclude_from_sim no) (in_bom yes) (on_board yes)',
           f'      (property "Reference" "{ref[0]}" (at 0 {half + 5.08} 0) {FONT})',
           f'      (property "Value" "{ref}" (at 0 {-half - 5.08} 0) {FONT})',
           f'      (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))',
           f'      (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))',
           f'      (symbol "{ref}_1_1"',
           f'        (rectangle (start {-body} {half + 2.54}) (end {body} {-half - 2.54})',
           f'          (stroke (width 0.254) (type default)) (fill (type background)))']
    for i, (name, _) in enumerate(left):
        out.append(sym_pin(name, i + 1, -body - STUB, half - i * PITCH, 0))
    for i, (name, _) in enumerate(right):
        out.append(sym_pin(name, len(left) + i + 1, body + STUB, half - i * PITCH, 180))
    out.append("      )")
    out.append("    )")
    return "\n".join(out)


def lib_two_pin(ref: str) -> str:
    return "\n".join([
        f'    (symbol "kiosk:{ref}" (pin_names (offset 0.508) hide)',
        '      (exclude_from_sim no) (in_bom yes) (on_board yes)',
        f'      (property "Reference" "{ref[0]}" (at 3.81 1.27 0) {FONT})',
        f'      (property "Value" "{ref}" (at 3.81 -1.27 0) {FONT})',
        f'      (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))',
        f'      (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))',
        f'      (symbol "{ref}_1_1"',
        '        (rectangle (start -1.27 2.54) (end 1.27 -2.54)',
        '          (stroke (width 0.254) (type default)) (fill (type none)))',
        sym_pin("1", 1, 0, 5.08, 270),
        sym_pin("2", 2, 0, -5.08, 90),
        "      )",
        "    )",
    ])


def instance(ref: str, value: str, x: float, y: float, pin_count: int, half: float) -> str:
    out = [f'  (symbol (lib_id "kiosk:{ref}") (at {x} {y} 0) (unit 1)',
           '    (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)',
           f'    (uuid "{uid("sym", ref)}")',
           f'    (property "Reference" "{ref}" (at {x} {y - half - 5.08} 0) {FONT})',
           f'    (property "Value" "{value}" (at {x} {y + half + 6.35} 0) {FONT})',
           f'    (property "Footprint" "{FOOTPRINTS[ref]}" (at {x} {y} 0)',
           '      (effects (font (size 1.27 1.27)) hide))',
           f'    (property "Datasheet" "" (at {x} {y} 0) (effects (font (size 1.27 1.27)) hide))']
    for n in range(1, pin_count + 1):
        out.append(f'    (pin "{n}" (uuid "{uid("pin", ref, n)}"))')
    out.append('    (instances')
    out.append('      (project "kiosk"')
    out.append(f'        (path "/{ROOT_UUID}" (reference "{ref}") (unit 1))')
    out.append('      )')
    out.append('    )')
    out.append('  )')
    return "\n".join(out)


def stub_label(ref: str, tag: object, net: str, px: float, py: float, side: str) -> str:
    """A wire out of the pin and the net name at its end."""
    dx = -STUB if side == "left" else STUB
    ex = px + dx
    angle = 180 if side == "left" else 0
    justify = "right" if side == "left" else "left"
    return "\n".join([
        f'  (wire (pts (xy {px} {py}) (xy {ex} {py}))',
        f'    (stroke (width 0) (type default)) (uuid "{uid("w", ref, tag)}"))',
        f'  (label "{net}" (at {ex} {py} {angle})',
        f'    (effects (font (size 1.27 1.27)) (justify {justify} bottom))',
        f'    (uuid "{uid("l", ref, tag)}"))',
    ])


def snap(value: float) -> float:
    """Onto KiCad's own 1.27 mm grid, which every pin offset is already a multiple of."""
    return round(round(value / (PITCH / 2)) * (PITCH / 2), 2)


def no_connect(ref: str, tag: str, x: float, y: float) -> str:
    """Says the empty pin is empty on purpose, which is what silences ERC."""
    return f'  (no_connect (at {x} {y}) (uuid "{uid("nc", ref, tag)}"))'


def main() -> None:
    lib, body, placed = [], [], []
    for ref, value, left, right, x, y in PARTS:
        x, y = snap(x), snap(y)
        rows = max(len(left), len(right))
        half = (rows - 1) * PITCH / 2.0
        width = 12.7 if right else 10.16
        lib.append(lib_symbol(ref, left, right))
        body.append(instance(ref, value, x, y, len(left) + len(right), half))
        for bank, side in ((left, "left"), (right, "right")):
            edge = x - width - STUB if side == "left" else x + width + STUB
            for i, (name, net) in enumerate(bank):
                py = y - half + i * PITCH
                if net:
                    body.append(stub_label(ref, name, net, edge, py, side))
                else:
                    body.append(no_connect(ref, name, edge, py))
        placed.append(ref)

    for ref, value, top, bottom, x, y in TWO_PIN:
        x, y = snap(x), snap(y)
        lib.append(lib_two_pin(ref))
        body.append(instance(ref, value, x, y, 2, 2.54))
        body.append(stub_label(ref, "top", top, x, y - 5.08, "right"))
        body.append(stub_label(ref, "bot", bottom, x, y + 5.08, "right"))

    text = "\n".join([
        "(kicad_sch",
        f"  (version {SHEET_FORMAT})",
        '  (generator "eeschema")',
        '  (generator_version "10.0")',
        "",
        f'  (uuid "{ROOT_UUID}")',
        "",
        '  (paper "A4" portrait)',
        "",
        "  (title_block",
        '    (title "Kiosk cham cong ESP32-S3 - board de")',
        '    (rev "A")',
        '    (comment 1 "Chan lay tu KE HOACH section 2. Sai lech thi section 2 dung.")',
        "  )",
        "",
        "  (lib_symbols",
        "\n".join(lib),
        "  )",
        "",
        "\n".join(body),
        "",
        "  (sheet_instances",
        '    (path "/" (page "1"))',
        "  )",
        ")",
    ])
    OUT.write_text(text + "\n", encoding="utf-8")
    print(f"{OUT}: {len(text.splitlines()) + 1} dong, {len(placed) + len(TWO_PIN)} linh kien")

    # The same symbols as a library of their own, so ERC has a source to point at.
    SYMBOLS.parent.mkdir(parents=True, exist_ok=True)
    SYMBOLS.write_text("\n".join([
        "(kicad_symbol_lib",
        f"  (version {SYMBOL_FORMAT})",
        '  (generator "kicad_symbol_editor")',
        '  (generator_version "10.0")',
        "\n".join(entry.replace('(symbol "kiosk:', '(symbol "', 1) for entry in lib),
        ")",
    ]) + "\n", encoding="utf-8")
    print(f"{SYMBOLS}: {len(lib)} ky hieu")


if __name__ == "__main__":
    main()
