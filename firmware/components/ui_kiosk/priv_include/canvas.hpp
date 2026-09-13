/** One byte a pixel: 0 lets the video through, the rest name a colour.
 *  @ctx ui_task | non-blocking | the map itself lives in PSRAM (KEHOACH 4.5.5h)
 */
#pragma once

#include <stdint.h>

#include "app_config.h"
#include "drv_lcd.h"

namespace ui {

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

    struct Region {
        int16_t x;
        int16_t y;
        int16_t w;
        int16_t h;
    };

    /** The bands of rows this screen painted, coalesced into at most cap boxes.
     *  A screen covers a fraction of the panel and the gaps are what makes
     *  sending the map affordable at all (KEHOACH 4.5.5h).
     */
    int regions(Region *out, int cap) const noexcept;
    void fill(int x, int y, int w, int h, uint8_t value) noexcept;
    void frame(int x, int y, int w, int h, int edge, uint8_t value) noexcept;

    /** A rounded rectangle, which is what every button and guide frame here is. */
    void rounded(int x, int y, int w, int h, int radius, int edge, uint8_t value) noexcept;

    /** Text with a shadow around it, so it reads over live video. */
    void text(int x, int y, const char *utf8, uint8_t ink) noexcept;
    void text_centred(int y, const char *utf8, uint8_t ink) noexcept;
    void text_centred_in(int x, int w, int y, const char *utf8, uint8_t ink) noexcept;

    static int text_width(const char *utf8) noexcept;
    static int line_height() noexcept;

private:
    void stamp(int pen_x, int top, const char *utf8, uint8_t value) noexcept;
    void touched(int x1, int y1, int x2, int y2) noexcept;

    uint8_t *cells_;
    int width_;
    int height_;
    int16_t row_x1_[APP_LCD_V_RES] = {};
    int16_t row_x2_[APP_LCD_V_RES] = {};
};

}  // namespace ui
