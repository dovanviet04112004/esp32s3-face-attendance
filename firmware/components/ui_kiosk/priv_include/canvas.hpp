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

    uint8_t *cells_;
    int width_;
    int height_;
};

}  // namespace ui
