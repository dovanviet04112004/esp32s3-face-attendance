/** One byte a pixel: palette index in the low nibble, coverage in the high.
 *  @ctx ui_task | non-blocking | the map itself lives in PSRAM (KEHOACH 4.5.5h)
 */
#pragma once

#include <stdint.h>

#include "app_config.h"
#include "drv_lcd.h"
#include "theme.hpp"

namespace ui {

enum class Align : uint8_t { Left, Centre, Right };

class Canvas {
public:
    Canvas(uint8_t *cells, int width, int height) noexcept
        : cells_(cells), width_(width), height_(height)
    {
    }

    int width() const noexcept { return width_; }
    int height() const noexcept { return height_; }
    uint8_t *cells() const noexcept { return cells_; }

    void clear() noexcept;

    /** Zero the whole map, for a buffer nothing has painted into yet. */
    void wipe() noexcept;

    struct Region {
        int16_t x;
        int16_t y;
        int16_t w;
        int16_t h;
    };

    /** The bands of rows worth sending, coalesced into at most cap boxes.
     *  A full-panel write costs 307 KB over SPI, so a screen that only lit one
     *  row must send one row (KEHOACH 4.5.5h).
     */
    int regions(Region *out, int cap) const noexcept;

    /** Narrow the next regions() to the cells that differ from base.
     *  @ctx ui_task | non-blocking | base is another slot's map, same size
     */
    void diff_from(const uint8_t *base) noexcept;

    /** Offer every painted cell instead, for a screen the glass has not seen. */
    void offer_painted() noexcept;

    void fill(int x, int y, int w, int h, uint8_t colour) noexcept;
    void frame(int x, int y, int w, int h, int edge, uint8_t colour) noexcept;

    /** A solid rounded rectangle with anti-aliased corners: every card here. */
    void card(int x, int y, int w, int h, int radius, uint8_t colour) noexcept;

    /** The outline of one, for a field or a selection ring. */
    void outline(int x, int y, int w, int h, int radius, int edge, uint8_t colour) noexcept;

    /** A filled circle, for icon tiles and status dots. */
    void disc(int cx, int cy, int radius, uint8_t colour) noexcept;

    /** A circle outline of a given thickness. */
    void ring(int cx, int cy, int radius, int thick, uint8_t colour) noexcept;

    /** Draw utf8 at x, cutting it with an ellipsis when it passes max_w.
     *  @ctx ui_task | non-blocking | y is the top of the line box, not a baseline
     */
    void text(theme::Font face, int x, int y, int max_w, const char *utf8, uint8_t colour,
              Align align = Align::Left) noexcept;

    /** The same, ringed in EDGE so it stays legible over live video. */
    void text_on_video(theme::Font face, int x, int y, int max_w, const char *utf8, uint8_t colour,
                       Align align = Align::Left) noexcept;

    /** Vertically centre a line inside a row of this height. */
    static int centre_y(theme::Font face, int top, int height) noexcept
    {
        return top + (height - theme::line_height(face)) / 2;
    }

private:
    static int span_of(theme::Font face, const char *utf8, int bytes) noexcept;
    void stamp(theme::Font face, int pen_x, int top, const char *utf8, int bytes,
               uint8_t colour, bool behind) noexcept;
    int start_x(theme::Font face, int x, int max_w, const char *utf8, int bytes,
                Align align) const noexcept;
    void put(int x, int y, uint8_t cell) noexcept;
    void touched(int x1, int y1, int x2, int y2) noexcept;

    uint8_t *cells_;
    int width_;
    int height_;
    int16_t row_x1_[APP_LCD_V_RES] = {};
    int16_t row_x2_[APP_LCD_V_RES] = {};
    int16_t send_x1_[APP_LCD_V_RES] = {};
    int16_t send_x2_[APP_LCD_V_RES] = {};
};

}  // namespace ui
