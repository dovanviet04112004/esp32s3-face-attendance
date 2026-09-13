// GENERATED FILE - DO NOT EDIT.
// Source: firmware/assets/fonts/gen_font.py
// Regenerate: ml/.venv/bin/python firmware/assets/fonts/gen_font.py

#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint16_t code;                        // unicode code point
    uint8_t w;
    uint8_t h;
    int8_t off_x;
    int8_t off_y;                         // from the line top, not the baseline
    uint8_t adv;                          // pen movement after this glyph
    uint16_t at;                          // first byte in the bitmap blob
} kiosk_glyph_t;

extern const uint8_t kiosk_sans_22_line_h;
extern const uint8_t kiosk_sans_22_ascent;
extern const uint16_t kiosk_sans_22_count;
extern const uint8_t kiosk_sans_22_bitmap[];
extern const kiosk_glyph_t kiosk_sans_22_glyphs[];

#ifdef __cplusplus
}
#endif
