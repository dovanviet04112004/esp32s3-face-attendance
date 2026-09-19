/** The palette, the type scale, the spacing steps, and the vertical stack.
 *  @ctx ui_task | non-blocking | every screen lays itself out through this
 */
#pragma once

#include <stdint.h>

#include "app_config.h"
#include "drv_lcd.h"
#include "kiosk_ui_20.h"

namespace ui {
namespace theme {

/** The four rasterised faces, in the order they grow. */
enum class Font : uint8_t {
    Caption = 0,                          // 15px medium, secondary lines
    Body,                                 // 20px regular, list rows
    Strong,                               // 24px medium, buttons and prompts
    Title,                                // 28px semibold, screen titles
    Count,
};

constexpr int kGutter = 20;               // panel edge to content
constexpr int kGapS = 8;
constexpr int kGapM = 14;
constexpr int kGapL = 24;
constexpr int kRadius = 18;
constexpr int kRadiusS = 12;
constexpr int kBarH = 40;                 // status strip across the top
constexpr int kRowH = 64;                 // one settings or list row
constexpr int kButtonH = 56;
constexpr int kTouchMin = 44;             // no target smaller than a fingertip

constexpr int kContentW = APP_LCD_H_RES - 2 * kGutter;

/** The colours, indexed by the DRV_LCD_* constants, in panel byte order.
 *  @ctx any | non-blocking | one shared table, handed to every mask
 */
const uint16_t *palette() noexcept;

int line_height(Font face) noexcept;
int ascent(Font face) noexcept;
int text_width(Font face, const char *utf8) noexcept;

/** The glyph for a code point in one face, or NULL when the face lacks it.
 *  @ctx any | non-blocking | binary search, the tables are sorted by code
 */
const kiosk_glyph_t *glyph_of(Font face, uint32_t code) noexcept;

/** The 4bpp blob a face's glyph offsets index into. */
const uint8_t *bitmap_of(Font face) noexcept;

/** Decode one UTF-8 sequence and step the cursor past it.
 *  @ctx any | non-blocking
 */
uint32_t next_code(const char **at) noexcept;

/** How many bytes of utf8 still fit in width, with room for an ellipsis.
 *  @ctx any | non-blocking | returns the whole length when it already fits
 */
int fits(Font face, const char *utf8, int width) noexcept;

/** Hands out row positions down a column so no screen adds up y by hand.
 *  @ctx ui_task | non-blocking | take() returns the top of the row it reserves
 */
class Stack {
public:
    Stack(int top, int left = kGutter, int width = kContentW) noexcept
        : y_(top), left_(left), width_(width)
    {
    }

    int take(int height, int gap = kGapM) noexcept
    {
        const int at = y_;
        y_ += height + gap;
        return at;
    }

    void skip(int gap) noexcept { y_ += gap; }

    int y() const noexcept { return y_; }
    int left() const noexcept { return left_; }
    int width() const noexcept { return width_; }

    /** True while another row of this height would still clear the panel. */
    bool fits(int height) const noexcept { return y_ + height <= APP_LCD_V_RES; }

private:
    int y_;
    int left_;
    int width_;
};

}  // namespace theme
}  // namespace ui
