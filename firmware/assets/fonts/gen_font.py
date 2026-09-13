"""Rasterise one TTF into the 1bpp glyph table ui_kiosk blits over the preview.

The kiosk draws its own text: LVGL owns the screens that have no video on them,
but the preview area is composited strip by strip (KEHOACH 4.5.5h), so the text
that goes over live video has to arrive as pixels the strip loop can copy.
"""

from __future__ import annotations

import argparse
import unicodedata
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ASCII = "".join(chr(c) for c in range(0x20, 0x7F))
VIETNAMESE_BASE = "aăâeêioôơuưy"
TONES = ["", "̀", "́", "̃", "̉", "̣"]


def vietnamese() -> str:
    """Every precomposed Vietnamese letter, both cases, plus the two d forms."""
    letters = set("đĐ")
    for base in VIETNAMESE_BASE:
        for tone in TONES:
            composed = unicodedata.normalize("NFC", base + tone)
            letters.add(composed)
            letters.add(composed.upper())
    return "".join(sorted(letters))


def glyphs_of(font: ImageFont.FreeTypeFont, text: str) -> list[dict]:
    out = []
    for ch in sorted(set(text)):
        mask = font.getmask(ch, mode="1")
        width, height = mask.size
        box = font.getbbox(ch)
        rows = []
        for y in range(height):
            bits = bytearray((width + 7) // 8)
            for x in range(width):
                if mask.getpixel((x, y)):
                    bits[x // 8] |= 0x80 >> (x % 8)
            rows.append(bytes(bits))
        out.append(
            {
                "code": ord(ch),
                "w": width,
                "h": height,
                "off_x": box[0],
                "off_y": box[1],
                "adv": round(font.getlength(ch)),
                "rows": rows,
            }
        )
    return out


def emit(name: str, size: int, glyphs: list[dict], ascent: int, line: int) -> str:
    blob = bytearray()
    table = []
    for g in glyphs:
        table.append((g, len(blob)))
        for row in g["rows"]:
            blob.extend(row)
    lines = [
        "// GENERATED FILE - DO NOT EDIT.",
        "// Source: firmware/assets/fonts/gen_font.py",
        "// Regenerate: ml/.venv/bin/python firmware/assets/fonts/gen_font.py",
        "",
        f'#include "{name}.h"',
        "",
        f"const uint8_t {name}_line_h = {line};",
        f"const uint8_t {name}_ascent = {ascent};",
        f"const uint16_t {name}_count = {len(glyphs)};",
        "",
        f"const uint8_t {name}_bitmap[] = {{",
    ]
    for i in range(0, len(blob), 16):
        chunk = ", ".join(f"0x{b:02X}" for b in blob[i : i + 16])
        lines.append(f"    {chunk},")
    lines.append("};")
    lines.append("")
    lines.append(f"const kiosk_glyph_t {name}_glyphs[] = {{")
    for g, at in table:
        lines.append(
            "    {{ {code}, {w}, {h}, {ox}, {oy}, {adv}, {at} }},".format(
                code=g["code"], w=g["w"], h=g["h"], ox=g["off_x"], oy=g["off_y"], adv=g["adv"], at=at
            )
        )
    lines.append("};")
    lines.append("")
    return "\n".join(lines)


def header(name: str) -> str:
    return "\n".join(
        [
            "// GENERATED FILE - DO NOT EDIT.",
            "// Source: firmware/assets/fonts/gen_font.py",
            "// Regenerate: ml/.venv/bin/python firmware/assets/fonts/gen_font.py",
            "",
            "#pragma once",
            "",
            "#include <stdint.h>",
            "",
            "#ifdef __cplusplus",
            'extern "C" {',
            "#endif",
            "",
            "typedef struct {",
            "    uint16_t code;                        // unicode code point",
            "    uint8_t w;",
            "    uint8_t h;",
            "    int8_t off_x;",
            "    int8_t off_y;                         // from the line top, not the baseline",
            "    uint8_t adv;                          // pen movement after this glyph",
            "    uint16_t at;                          // first byte in the bitmap blob",
            "} kiosk_glyph_t;",
            "",
            f"extern const uint8_t {name}_line_h;",
            f"extern const uint8_t {name}_ascent;",
            f"extern const uint16_t {name}_count;",
            f"extern const uint8_t {name}_bitmap[];",
            f"extern const kiosk_glyph_t {name}_glyphs[];",
            "",
            "#ifdef __cplusplus",
            "}",
            "#endif",
            "",
        ]
    )


def main() -> None:
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ttf", default="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
    parser.add_argument("--size", type=int, default=22)
    parser.add_argument("--name", default="kiosk_sans")
    args = parser.parse_args()

    font = ImageFont.truetype(args.ttf, args.size)
    ascent, descent = font.getmetrics()
    text = ASCII + vietnamese()
    glyphs = glyphs_of(font, text)
    stem = f"{args.name}_{args.size}"
    (here / f"{stem}.c").write_text(emit(stem, args.size, glyphs, ascent, ascent + descent), encoding="utf-8")
    (here / f"{stem}.h").write_text(header(stem), encoding="utf-8")
    blob = sum(len(r) for g in glyphs for r in g["rows"])
    print(f"{stem}: {len(glyphs)} glyphs, {blob} bytes of bitmap, line {ascent + descent}px")


if __name__ == "__main__":
    main()
