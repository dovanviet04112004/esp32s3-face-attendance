#include "canvas.hpp"

#include <string.h>

#include "kiosk_sans_22.h"

namespace ui {

namespace {

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

const kiosk_glyph_t *glyph_of(uint32_t code)
{
    int low = 0;
    int high = (int)kiosk_sans_22_count - 1;
    while (low <= high) {
        const int mid = (low + high) / 2;
        const uint32_t here = kiosk_sans_22_glyphs[mid].code;
        if (here == code) {
            return &kiosk_sans_22_glyphs[mid];
        }
        if (here < code) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return nullptr;
}

}  // namespace

int Canvas::text_width(const char *utf8) noexcept
{
    int width = 0;
    while (*utf8 != '\0') {
        const kiosk_glyph_t *glyph = glyph_of(code_point(&utf8));
        width += glyph != nullptr ? glyph->adv : 0;
    }
    return width;
}

int Canvas::line_height() noexcept
{
    return kiosk_sans_22_line_h;
}

void Canvas::clear() noexcept
{
    memset(cells_, 0, (size_t)width_ * height_);
    for (int row = 0; row < height_; ++row) {
        row_x1_[row] = (int16_t)width_;
        row_x2_[row] = 0;
    }
}

void Canvas::touched(int x1, int y1, int x2, int y2) noexcept
{
    for (int row = y1; row < y2; ++row) {
        row_x1_[row] = x1 < row_x1_[row] ? (int16_t)x1 : row_x1_[row];
        row_x2_[row] = x2 > row_x2_[row] ? (int16_t)x2 : row_x2_[row];
    }
}

int Canvas::regions(Region *out, int cap) const noexcept
{
    int kept = 0;
    int row = 0;
    while (row < height_ && kept < cap) {
        if (row_x2_[row] <= row_x1_[row]) {
            ++row;
            continue;
        }
        int left = row_x1_[row];
        int right = row_x2_[row];
        const int top = row;
        while (row < height_ && row_x2_[row] > row_x1_[row]) {
            left = row_x1_[row] < left ? row_x1_[row] : left;
            right = row_x2_[row] > right ? row_x2_[row] : right;
            ++row;
        }
        out[kept].x = (int16_t)left;
        out[kept].y = (int16_t)top;
        out[kept].w = (int16_t)(right - left);
        out[kept].h = (int16_t)(row - top);
        ++kept;
    }
    return kept;
}

void Canvas::fill(int x, int y, int w, int h, uint8_t value) noexcept
{
    const int x1 = x > 0 ? x : 0;
    const int y1 = y > 0 ? y : 0;
    const int x2 = x + w < width_ ? x + w : width_;
    const int y2 = y + h < height_ ? y + h : height_;
    if (x2 <= x1 || y2 <= y1) {
        return;
    }
    for (int row = y1; row < y2; ++row) {
        memset(cells_ + (size_t)row * width_ + x1, value, (size_t)(x2 - x1));
    }
    touched(x1, y1, x2, y2);
}

void Canvas::frame(int x, int y, int w, int h, int edge, uint8_t value) noexcept
{
    fill(x, y, w, edge, value);
    fill(x, y + h - edge, w, edge, value);
    fill(x, y, edge, h, value);
    fill(x + w - edge, y, edge, h, value);
}

// Corners come off with one circle test per pixel, which is cheap enough at the
// handful of frames a screen change costs.
void Canvas::rounded(int x, int y, int w, int h, int radius, int edge, uint8_t value) noexcept
{
    frame(x, y, w, h, edge, value);
    const int inner = (radius - edge) * (radius - edge);
    const int outer = radius * radius;
    for (int dy = 0; dy < radius; ++dy) {
        for (int dx = 0; dx < radius; ++dx) {
            const int rx = radius - dx;
            const int ry = radius - dy;
            const int at = rx * rx + ry * ry;
            const bool on = at <= outer && at >= inner;
            const bool off = at > outer;
            const int left = x + dx;
            const int right = x + w - 1 - dx;
            const int top = y + dy;
            const int bottom = y + h - 1 - dy;
            if (off) {
                fill(left, top, 1, 1, 0);
                fill(right, top, 1, 1, 0);
                fill(left, bottom, 1, 1, 0);
                fill(right, bottom, 1, 1, 0);
            } else if (on) {
                fill(left, top, 1, 1, value);
                fill(right, top, 1, 1, value);
                fill(left, bottom, 1, 1, value);
                fill(right, bottom, 1, 1, value);
            }
        }
    }
}

void Canvas::stamp(int pen_x, int top, const char *utf8, uint8_t value) noexcept
{
    while (*utf8 != '\0') {
        const kiosk_glyph_t *glyph = glyph_of(code_point(&utf8));
        if (glyph == nullptr) {
            continue;
        }
        const uint8_t *bits = &kiosk_sans_22_bitmap[glyph->at];
        const int stride = (glyph->w + 7) / 8;
        for (int gy = 0; gy < glyph->h; ++gy) {
            const int row = top + glyph->off_y + gy;
            if (row < 0 || row >= height_) {
                continue;
            }
            for (int gx = 0; gx < glyph->w; ++gx) {
                const int col = pen_x + glyph->off_x + gx;
                if (col < 0 || col >= width_) {
                    continue;
                }
                if ((bits[gy * stride + gx / 8] & (0x80u >> (gx % 8))) == 0) {
                    continue;
                }
                uint8_t *cell = &cells_[(size_t)row * width_ + col];
                if (value != DRV_LCD_EDGE || *cell == 0) {
                    *cell = value;
                    touched(col, row, col + 1, row + 1);
                }
            }
        }
        pen_x += glyph->adv;
    }
}

void Canvas::text(int x, int y, const char *utf8, uint8_t ink) noexcept
{
    for (int dy = -1; dy <= 1; ++dy) {
        for (int dx = -1; dx <= 1; ++dx) {
            if (dx != 0 || dy != 0) {
                stamp(x + dx, y + dy, utf8, DRV_LCD_EDGE);
            }
        }
    }
    stamp(x, y, utf8, ink);
}

void Canvas::text_centred(int y, const char *utf8, uint8_t ink) noexcept
{
    text((width_ - text_width(utf8)) / 2, y, utf8, ink);
}

void Canvas::text_centred_in(int x, int w, int y, const char *utf8, uint8_t ink) noexcept
{
    text(x + (w - text_width(utf8)) / 2, y, utf8, ink);
}

}  // namespace ui
