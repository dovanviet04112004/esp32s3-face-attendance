"""Rasterise MiSans Latin into the 4bpp glyph tables ui_kiosk paints with.

The kiosk draws its own text: the preview area is composited strip by strip
(KEHOACH 4.5.5h), so text going over live video has to arrive as pixels the
strip loop can copy. Four faces make the type scale of theme.hpp; each carries
a coverage level per pixel, which the cover byte's high nibble takes.
"""

from __future__ import annotations

import argparse
import unicodedata
from pathlib import Path

from PIL import ImageFont

ASCII = "".join(chr(c) for c in range(0x20, 0x7F))
VIETNAMESE_BASE = "aăâeêioôơuưy"
TONES = ["", "̀", "́", "̃", "̉", "̣"]
EXTRA = "·…°"
MISANS = str(Path.home() / ".local/share/fonts/MiSansLatinVF.ttf")

# Size, weight axis, and the role each face carries in theme.hpp.
FACES = [
    (15, 400, "caption"),
    (20, 400, "body"),
    (24, 500, "strong"),
    (28, 600, "title"),
]


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
    """Rasterise each character to 4bpp, two pixels a byte, left pixel high."""
    out = []
    for ch in sorted(set(text)):
        mask = font.getmask(ch, mode="L")
        width, height = mask.size
        box = font.getbbox(ch)
        rows = []
        for y in range(height):
            packed = bytearray((width + 1) // 2)
            for x in range(width):
                level = mask.getpixel((x, y)) >> 4
                if x % 2 == 0:
                    packed[x // 2] |= level << 4
                else:
                    packed[x // 2] |= level
            rows.append(bytes(packed))
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


def emit(name: str, glyphs: list[dict], ascent: int, line: int) -> str:
    """Build the .c body: one bitmap blob plus a table sorted by code point."""
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
                code=g["code"], w=g["w"], h=g["h"], ox=g["off_x"], oy=g["off_y"],
                adv=g["adv"], at=at,
            )
        )
    lines.append("};")
    lines.append("")
    return "\n".join(lines)


def header(name: str) -> str:
    """Build the .h: the shared glyph struct plus this face's five symbols."""
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
            "#ifndef KIOSK_GLYPH_T_DEFINED",
            "#define KIOSK_GLYPH_T_DEFINED",
            "typedef struct {",
            "    uint16_t code;                        // unicode code point",
            "    uint8_t w;",
            "    uint8_t h;",
            "    int8_t off_x;",
            "    int8_t off_y;                         // from the line top, not the baseline",
            "    uint8_t adv;                          // pen movement after this glyph",
            "    uint32_t at;                          // first byte in the bitmap blob",
            "} kiosk_glyph_t;",
            "#endif",
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
    parser.add_argument("--ttf", default=MISANS)
    parser.add_argument("--name", default="kiosk_ui")
    args = parser.parse_args()

    text = ASCII + vietnamese() + EXTRA
    total = 0
    for size, weight, role in FACES:
        font = ImageFont.truetype(args.ttf, size)
        font.set_variation_by_axes([weight])
        ascent, descent = font.getmetrics()
        glyphs = glyphs_of(font, text)
        stem = f"{args.name}_{size}"
        (here / f"{stem}.c").write_text(emit(stem, glyphs, ascent, ascent + descent), encoding="utf-8")
        (here / f"{stem}.h").write_text(header(stem), encoding="utf-8")
        blob = sum(len(r) for g in glyphs for r in g["rows"])
        total += blob
        print(f"{stem:14} w{weight} {role:8} {len(glyphs)} glyphs, {blob:6d} B, line {ascent + descent}px")
    print(f"total bitmap: {total} B")


if __name__ == "__main__":
    main()
