#include "canvas.hpp"

#include <math.h>
#include <string.h>

namespace ui {

namespace {

constexpr uint32_t kEllipsis = 0x2026;
constexpr uint8_t kHaloFloor = 5;

uint8_t coverage_at(float distance, float radius)
{
    const float over = radius - distance + 0.5f;
    if (over <= 0.0f) {
        return 0;
    }
    if (over >= 1.0f) {
        return DRV_LCD_COVER_FULL;
    }
    return (uint8_t)(over * (float)DRV_LCD_COVER_FULL);
}

}  // namespace

// Wiping all 153 KB costs more than the painting does, and everything outside
// the spans the last screen touched is already zero.
void Canvas::clear() noexcept
{
    for (int row = 0; row < height_; ++row) {
        if (row_x2_[row] > row_x1_[row]) {
            memset(cells_ + (size_t)row * width_ + row_x1_[row], 0,
                   (size_t)(row_x2_[row] - row_x1_[row]));
        }
        row_x1_[row] = (int16_t)width_;
        row_x2_[row] = 0;
    }
}

void Canvas::wipe() noexcept
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

void Canvas::offer_painted() noexcept
{
    memcpy(send_x1_, row_x1_, sizeof(send_x1_));
    memcpy(send_x2_, row_x2_, sizeof(send_x2_));
}

int Canvas::regions(Region *out, int cap) const noexcept
{
    int kept = 0;
    int row = 0;
    while (row < height_ && kept < cap) {
        if (send_x2_[row] <= send_x1_[row]) {
            ++row;
            continue;
        }
        int left = send_x1_[row];
        int right = send_x2_[row];
        const int top = row;
        while (row < height_ && send_x2_[row] > send_x1_[row]) {
            left = send_x1_[row] < left ? send_x1_[row] : left;
            right = send_x2_[row] > right ? send_x2_[row] : right;
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

// Strokes and rings are laid down as overlapping discs, so a later rim must
// not erase an earlier centre: same colour keeps whichever covers more.
void Canvas::put(int x, int y, uint8_t cell) noexcept
{
    if (x < 0 || x >= width_ || y < 0 || y >= height_) {
        return;
    }
    uint8_t *at = &cells_[(size_t)y * width_ + x];
    if ((*at & 0x0Fu) == (cell & 0x0Fu) && (*at >> 4) >= (cell >> 4)) {
        return;
    }
    *at = cell;
    touched(x, y, x + 1, y + 1);
}

void Canvas::fill(int x, int y, int w, int h, uint8_t colour) noexcept
{
    const int x1 = x > 0 ? x : 0;
    const int y1 = y > 0 ? y : 0;
    const int x2 = x + w < width_ ? x + w : width_;
    const int y2 = y + h < height_ ? y + h : height_;
    if (x2 <= x1 || y2 <= y1) {
        return;
    }
    const uint8_t cell = DRV_LCD_CELL(colour, DRV_LCD_COVER_FULL);
    for (int row = y1; row < y2; ++row) {
        memset(cells_ + (size_t)row * width_ + x1, cell, (size_t)(x2 - x1));
    }
    touched(x1, y1, x2, y2);
}

void Canvas::frame(int x, int y, int w, int h, int edge, uint8_t colour) noexcept
{
    fill(x, y, w, edge, colour);
    fill(x, y + h - edge, w, edge, colour);
    fill(x, y, edge, h, colour);
    fill(x + w - edge, y, edge, h, colour);
}

void Canvas::card(int x, int y, int w, int h, int radius, uint8_t colour) noexcept
{
    const int r = radius * 2 <= h ? radius : h / 2;
    fill(x, y + r, w, h - 2 * r, colour);
    fill(x + r, y, w - 2 * r, r, colour);
    fill(x + r, y + h - r, w - 2 * r, r, colour);
    const float centre = (float)r - 0.5f;
    for (int dy = 0; dy < r; ++dy) {
        for (int dx = 0; dx < r; ++dx) {
            const float ox = centre - (float)dx;
            const float oy = centre - (float)dy;
            const uint8_t level = coverage_at(sqrtf(ox * ox + oy * oy), (float)r);
            if (level == 0) {
                continue;
            }
            const uint8_t cell = DRV_LCD_CELL(colour, level);
            put(x + dx, y + dy, cell);
            put(x + w - 1 - dx, y + dy, cell);
            put(x + dx, y + h - 1 - dy, cell);
            put(x + w - 1 - dx, y + h - 1 - dy, cell);
        }
    }
}

void Canvas::outline(int x, int y, int w, int h, int radius, int edge, uint8_t colour) noexcept
{
    const int r = radius * 2 <= h ? radius : h / 2;
    fill(x, y + r, edge, h - 2 * r, colour);
    fill(x + w - edge, y + r, edge, h - 2 * r, colour);
    fill(x + r, y, w - 2 * r, edge, colour);
    fill(x + r, y + h - edge, w - 2 * r, edge, colour);
    const float centre = (float)r - 0.5f;
    const float inner = (float)(r - edge);
    for (int dy = 0; dy < r; ++dy) {
        for (int dx = 0; dx < r; ++dx) {
            const float ox = centre - (float)dx;
            const float oy = centre - (float)dy;
            const float d = sqrtf(ox * ox + oy * oy);
            const uint8_t out = coverage_at(d, (float)r);
            const uint8_t in = coverage_at(d, inner);
            if (out <= in) {
                continue;
            }
            const uint8_t cell = DRV_LCD_CELL(colour, (uint8_t)(out - in));
            put(x + dx, y + dy, cell);
            put(x + w - 1 - dx, y + dy, cell);
            put(x + dx, y + h - 1 - dy, cell);
            put(x + w - 1 - dx, y + h - 1 - dy, cell);
        }
    }
}

void Canvas::disc(int cx, int cy, int radius, uint8_t colour) noexcept
{
    for (int dy = -radius; dy <= radius; ++dy) {
        for (int dx = -radius; dx <= radius; ++dx) {
            const uint8_t level =
                coverage_at(sqrtf((float)(dx * dx + dy * dy)), (float)radius);
            if (level != 0) {
                put(cx + dx, cy + dy, DRV_LCD_CELL(colour, level));
            }
        }
    }
}

void Canvas::ring(int cx, int cy, int radius, int thick, uint8_t colour) noexcept
{
    const float inner = (float)(radius - thick);
    for (int dy = -radius; dy <= radius; ++dy) {
        for (int dx = -radius; dx <= radius; ++dx) {
            const float d = sqrtf((float)(dx * dx + dy * dy));
            const uint8_t out = coverage_at(d, (float)radius);
            const uint8_t in = coverage_at(d, inner);
            if (out > in) {
                put(cx + dx, cy + dy, DRV_LCD_CELL(colour, (uint8_t)(out - in)));
            }
        }
    }
}

void Canvas::stamp(theme::Font face, int pen_x, int top, const char *utf8, int bytes,
                   uint8_t colour, bool behind) noexcept
{
    const uint8_t *blob = theme::bitmap_of(face);
    const char *walk = utf8;
    while (walk < utf8 + bytes && *walk != '\0') {
        const kiosk_glyph_t *glyph = theme::glyph_of(face, theme::next_code(&walk));
        if (glyph == nullptr) {
            continue;
        }
        const int stride = (glyph->w + 1) / 2;
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
                const uint8_t packed = blob[glyph->at + gy * stride + gx / 2];
                const uint8_t level = (gx % 2) == 0 ? (packed >> 4) : (packed & 0x0Fu);
                if (level == 0) {
                    continue;
                }
                uint8_t *cell = &cells_[(size_t)row * width_ + col];
                // The shadow pass only fills what the ink has not claimed.
                if (behind && (*cell != 0 || level < kHaloFloor)) {
                    continue;
                }
                *cell = DRV_LCD_CELL(colour, behind ? DRV_LCD_COVER_FULL : level);
                touched(col, row, col + 1, row + 1);
            }
        }
        pen_x += glyph->adv;
    }
}

int Canvas::span_of(theme::Font face, const char *utf8, int bytes) noexcept
{
    int used = 0;
    const char *walk = utf8;
    while (walk < utf8 + bytes && *walk != '\0') {
        const kiosk_glyph_t *glyph = theme::glyph_of(face, theme::next_code(&walk));
        used += glyph != nullptr ? glyph->adv : 0;
    }
    return used;
}

int Canvas::start_x(theme::Font face, int x, int max_w, const char *utf8, int bytes,
                    Align align) const noexcept
{
    if (align == Align::Left) {
        return x;
    }
    int used = span_of(face, utf8, bytes);
    if (bytes < (int)strlen(utf8)) {
        const kiosk_glyph_t *dots = theme::glyph_of(face, kEllipsis);
        used += dots != nullptr ? dots->adv : 0;
    }
    return align == Align::Centre ? x + (max_w - used) / 2 : x + max_w - used;
}

void Canvas::text(theme::Font face, int x, int y, int max_w, const char *utf8, uint8_t colour,
                  Align align) noexcept
{
    const int bytes = theme::fits(face, utf8, max_w);
    const int pen = start_x(face, x, max_w, utf8, bytes, align);
    stamp(face, pen, y, utf8, bytes, colour, false);
    if (bytes < (int)strlen(utf8)) {
        stamp(face, pen + span_of(face, utf8, bytes), y, "\xE2\x80\xA6", 3, colour, false);
    }
}

void Canvas::text_on_video(theme::Font face, int x, int y, int max_w, const char *utf8,
                           uint8_t colour, Align align) noexcept
{
    const int bytes = theme::fits(face, utf8, max_w);
    const int pen = start_x(face, x, max_w, utf8, bytes, align);
    for (int dy = -1; dy <= 1; ++dy) {
        for (int dx = -1; dx <= 1; ++dx) {
            if (dx != 0 || dy != 0) {
                stamp(face, pen + dx, y + dy, utf8, bytes, DRV_LCD_EDGE, true);
            }
        }
    }
    stamp(face, pen, y, utf8, bytes, colour, false);
    if (bytes < (int)strlen(utf8)) {
        stamp(face, pen + span_of(face, utf8, bytes), y, "\xE2\x80\xA6", 3, colour, false);
    }
}

}  // namespace ui
