#include "theme.hpp"

#include <string.h>

#include "kiosk_ui_15.h"
#include "kiosk_ui_20.h"
#include "kiosk_ui_24.h"
#include "kiosk_ui_28.h"

namespace ui {
namespace theme {

namespace {

constexpr uint16_t rgb(uint32_t hex)
{
    const uint16_t packed = (uint16_t)((((hex >> 19) & 0x1Fu) << 11) |
                                       (((hex >> 10) & 0x3Fu) << 5) | ((hex >> 3) & 0x1Fu));
    // The preview path does not swap on the way out (KEHOACH 4.5.5h).
    return (uint16_t)((packed >> 8) | (packed << 8));
}

// RGB565 gives red and blue 32 steps and green 64, so a grey written as one
// 8-bit value per channel lands off-neutral and reads pink on a flat fill.
constexpr uint16_t grey(uint32_t level)
{
    const uint32_t g = (level * 63 + 15) / 31;
    const uint16_t packed = (uint16_t)((level << 11) | (g << 5) | level);
    return (uint16_t)((packed >> 8) | (packed << 8));
}

constexpr uint16_t kUnused = grey(0);
constexpr uint16_t kInk = grey(31);
constexpr uint16_t kEdge = grey(0);
constexpr uint16_t kAccent = rgb(0x3482FF);
constexpr uint16_t kWarn = rgb(0xFFD60A);
constexpr uint16_t kGround = grey(2);
constexpr uint16_t kSurface = grey(6);
constexpr uint16_t kSurfaceHi = grey(11);
constexpr uint16_t kLine = grey(9);
constexpr uint16_t kDim = grey(19);
constexpr uint16_t kOk = rgb(0x30D158);
constexpr uint16_t kDanger = rgb(0xFF453A);

constexpr uint16_t kPalette[DRV_LCD_COLOURS] = {
    kUnused, kInk,  kEdge, kAccent,    kWarn, kGround,
    kSurface, kSurfaceHi, kLine, kDim, kOk,   kDanger,
};

const kiosk_glyph_t *const kGlyphs[(int)Font::Count] = {
    kiosk_ui_15_glyphs, kiosk_ui_20_glyphs, kiosk_ui_24_glyphs, kiosk_ui_28_glyphs,
};

const uint8_t *const kBitmaps[(int)Font::Count] = {
    kiosk_ui_15_bitmap, kiosk_ui_20_bitmap, kiosk_ui_24_bitmap, kiosk_ui_28_bitmap,
};

const uint16_t kCounts[(int)Font::Count] = {
    kiosk_ui_15_count, kiosk_ui_20_count, kiosk_ui_24_count, kiosk_ui_28_count,
};

const uint8_t kLineHeights[(int)Font::Count] = {
    kiosk_ui_15_line_h, kiosk_ui_20_line_h, kiosk_ui_24_line_h, kiosk_ui_28_line_h,
};

const uint8_t kAscents[(int)Font::Count] = {
    kiosk_ui_15_ascent, kiosk_ui_20_ascent, kiosk_ui_24_ascent, kiosk_ui_28_ascent,
};

uint32_t code_point(const char **at)
{
    const uint8_t *p = (const uint8_t *)*at;
    uint32_t code = *p++;
    int extra = 0;
    if ((code & 0xE0u) == 0xC0u) {
        code &= 0x1Fu;
        extra = 1;
    } else if ((code & 0xF0u) == 0xE0u) {
        code &= 0x0Fu;
        extra = 2;
    } else if ((code & 0xF8u) == 0xF0u) {
        code &= 0x07u;
        extra = 3;
    }
    for (int i = 0; i < extra && (*p & 0xC0u) == 0x80u; ++i) {
        code = (code << 6) | (*p++ & 0x3Fu);
    }
    *at = (const char *)p;
    return code;
}

constexpr uint32_t kEllipsis = 0x2026;

}  // namespace

const uint16_t *palette() noexcept
{
    return kPalette;
}

const kiosk_glyph_t *glyph_of(Font face, uint32_t code) noexcept
{
    const kiosk_glyph_t *table = kGlyphs[(int)face];
    int low = 0;
    int high = (int)kCounts[(int)face] - 1;
    while (low <= high) {
        const int mid = (low + high) / 2;
        const uint32_t here = table[mid].code;
        if (here == code) {
            return &table[mid];
        }
        if (here < code) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return nullptr;
}

const uint8_t *bitmap_of(Font face) noexcept
{
    return kBitmaps[(int)face];
}

uint32_t next_code(const char **at) noexcept
{
    return code_point(at);
}

int line_height(Font face) noexcept
{
    return kLineHeights[(int)face];
}

int ascent(Font face) noexcept
{
    return kAscents[(int)face];
}

int text_width(Font face, const char *utf8) noexcept
{
    int width = 0;
    while (*utf8 != '\0') {
        const kiosk_glyph_t *glyph = glyph_of(face, code_point(&utf8));
        width += glyph != nullptr ? glyph->adv : 0;
    }
    return width;
}

int fits(Font face, const char *utf8, int width) noexcept
{
    if (text_width(face, utf8) <= width) {
        return (int)strlen(utf8);
    }
    const kiosk_glyph_t *dots = glyph_of(face, kEllipsis);
    const int room = width - (dots != nullptr ? dots->adv : 0);
    const char *walk = utf8;
    int taken = 0;
    int used = 0;
    while (*walk != '\0') {
        const kiosk_glyph_t *glyph = glyph_of(face, code_point(&walk));
        used += glyph != nullptr ? glyph->adv : 0;
        if (used > room) {
            break;
        }
        taken = (int)(walk - utf8);
    }
    return taken;
}

}  // namespace theme
}  // namespace ui
