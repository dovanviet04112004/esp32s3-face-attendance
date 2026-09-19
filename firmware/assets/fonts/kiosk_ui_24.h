// GENERATED FILE - DO NOT EDIT.
// Source: firmware/assets/fonts/gen_font.py
// Regenerate: ml/.venv/bin/python firmware/assets/fonts/gen_font.py

#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifndef KIOSK_GLYPH_T_DEFINED
#define KIOSK_GLYPH_T_DEFINED
typedef struct {
    uint16_t code;                        // unicode code point
    uint8_t w;
    uint8_t h;
    int8_t off_x;
    int8_t off_y;                         // from the line top, not the baseline
    uint8_t adv;                          // pen movement after this glyph
    uint32_t at;                          // first byte in the bitmap blob
} kiosk_glyph_t;
#endif

extern const uint8_t kiosk_ui_24_line_h;
extern const uint8_t kiosk_ui_24_ascent;
extern const uint16_t kiosk_ui_24_count;
extern const uint8_t kiosk_ui_24_bitmap[];
extern const kiosk_glyph_t kiosk_ui_24_glyphs[];

#ifdef __cplusplus
}
#endif
