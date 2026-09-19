#include "widgets.hpp"

#include <math.h>

namespace ui {
namespace widgets {

namespace {

constexpr int kTile = 38;
constexpr int kTileRadius = 11;
constexpr int kRowPad = 14;
constexpr int kChevronW = 10;
constexpr int kTrackH = 8;
constexpr int kKnobR = 13;
constexpr int kBackBox = 40;
constexpr int kBackX = 8;
constexpr int kKeyRadius = 8;
constexpr int kLabelFloor = 72;

int clampi(int v, int low, int high)
{
    return v < low ? low : (v > high ? high : v);
}

// A ring band kept to the 90 degree wedge that opens away from the viewer, which
// is the shape every wifi meter draws.
void arc_up(Canvas &to, int cx, int cy, int radius, int thick, uint8_t colour)
{
    for (int dy = -radius; dy <= 0; ++dy) {
        for (int dx = -radius; dx <= radius; ++dx) {
            if (-dy < (dx < 0 ? -dx : dx)) {
                continue;
            }
            const float d = sqrtf((float)(dx * dx + dy * dy));
            if (d <= (float)radius && d >= (float)(radius - thick)) {
                to.fill(cx + dx, cy + dy, 1, 1, colour);
            }
        }
    }
}

void bars_of(Canvas &to, int x, int y, int size, int level, uint8_t lit, uint8_t rest)
{
    const int bar = size / 6;
    const int gap = (size - 4 * bar) / 3;
    const int foot = y + size - size / 8;
    for (int i = 0; i < 4; ++i) {
        const int tall = size / 4 + i * size / 5;
        to.card(x + i * (bar + gap), foot - tall, bar, tall, bar / 2, i < level ? lit : rest);
    }
}

void draw_wifi(Canvas &to, int x, int y, int size, uint8_t colour)
{
    bars_of(to, x, y, size, 4, colour, colour);
}

void draw_lock(Canvas &to, int x, int y, int size, uint8_t colour)
{
    const int body_h = size / 2;
    const int body_w = size * 2 / 3;
    const int bx = x + (size - body_w) / 2;
    const int by = y + size - body_h - size / 12;
    to.card(bx, by, body_w, body_h, 3, colour);
    const int r = body_w / 3;
    arc_up(to, x + size / 2, by + 1, r, 2, colour);
}

void draw_person(Canvas &to, int x, int y, int size, uint8_t colour)
{
    const int head = size / 5;
    to.disc(x + size / 2, y + size / 3, head, colour);
    const int body_w = size * 2 / 3;
    to.card(x + (size - body_w) / 2, y + size / 2 + 2, body_w, size / 3, size / 6, colour);
}

void draw_backspace(Canvas &to, int x, int y, int size, uint8_t colour)
{
    const int h = size / 2;
    const int top = y + (size - h) / 2;
    const int tip = x + size / 6;
    const int right = x + size - size / 6;
    to.card(x + size / 3, top, right - x - size / 3, h, 3, colour);
    for (int i = 0; i < h / 2; ++i) {
        to.fill(tip + i, top + h / 2 - i, 1, 2 * i + 1, colour);
    }
    const int cx = x + size / 2 + 2;
    const int arm = h / 5;
    stroke(to, cx - arm, top + h / 2 - arm, cx + arm, top + h / 2 + arm, 2, DRV_LCD_SURFACE);
    stroke(to, cx + arm, top + h / 2 - arm, cx - arm, top + h / 2 + arm, 2, DRV_LCD_SURFACE);
}

void draw_keyboard(Canvas &to, int x, int y, int size, uint8_t colour)
{
    const int w = size * 5 / 6;
    const int h = size * 3 / 5;
    const int bx = x + (size - w) / 2;
    const int by = y + (size - h) / 2;
    to.outline(bx, by, w, h, 4, 2, colour);
    const int step = w / 5;
    for (int row = 0; row < 2; ++row) {
        for (int col = 0; col < 4; ++col) {
            to.fill(bx + step / 2 + col * step, by + h / 4 + row * h / 4, 2, 2, colour);
        }
    }
    stroke(to, bx + step, by + h - h / 5, bx + w - step, by + h - h / 5, 2, colour);
}

void draw_person_add(Canvas &to, int x, int y, int size, uint8_t colour)
{
    draw_person(to, x - size / 6, y, size, colour);
    const int cx = x + size - size / 5;
    const int cy = y + size / 2;
    const int arm = size / 5;
    stroke(to, cx - arm, cy, cx + arm, cy, 3, colour);
    stroke(to, cx, cy - arm, cx, cy + arm, 3, colour);
}

void draw_list(Canvas &to, int x, int y, int size, uint8_t colour)
{
    const int dot = 2;
    for (int i = 0; i < 3; ++i) {
        const int row = y + size / 4 + i * (size / 4);
        to.disc(x + size / 5, row, dot, colour);
        stroke(to, x + size / 5 + 6, row, x + size - size / 6, row, 3, colour);
    }
}

void draw_device(Canvas &to, int x, int y, int size, uint8_t colour)
{
    const int w = size * 3 / 5;
    const int h = size * 5 / 6;
    const int bx = x + (size - w) / 2;
    const int by = y + (size - h) / 2;
    to.outline(bx, by, w, h, 5, 2, colour);
    stroke(to, bx + w / 3, by + h - 5, bx + w * 2 / 3, by + h - 5, 2, colour);
}

void draw_brightness(Canvas &to, int x, int y, int size, uint8_t colour)
{
    const int cx = x + size / 2;
    const int cy = y + size / 2;
    to.disc(cx, cy, size / 5, colour);
    const int from = size / 5 + 3;
    const int to_r = size / 2 - 1;
    for (int i = 0; i < 8; ++i) {
        const float a = (float)i * 3.14159265f / 4.0f;
        const float ux = cosf(a);
        const float uy = sinf(a);
        stroke(to, cx + (int)(ux * from), cy + (int)(uy * from), cx + (int)(ux * to_r),
               cy + (int)(uy * to_r), 3, colour);
    }
}

void draw_volume(Canvas &to, int x, int y, int size, uint8_t colour)
{
    const int cx = x + size / 3;
    const int cy = y + size / 2;
    to.fill(x + size / 6, cy - size / 8, size / 6, size / 4, colour);
    for (int i = 0; i <= size / 4; ++i) {
        const int half = size / 8 + i;
        to.fill(cx + i, cy - half, 1, 2 * half, colour);
    }
    for (int band = 1; band <= 2; ++band) {
        const int r = band * size / 6;
        for (int dy = -r; dy <= r; ++dy) {
            for (int dx = 0; dx <= r; ++dx) {
                if (dx < (dy < 0 ? -dy : dy)) {
                    continue;
                }
                const float d = sqrtf((float)(dx * dx + dy * dy));
                if (d <= (float)r && d >= (float)(r - 2)) {
                    to.fill(x + size * 5 / 8 + dx, cy + dy, 1, 1, colour);
                }
            }
        }
    }
}

void draw_chevron(Canvas &to, int x, int y, int size, uint8_t colour, bool back)
{
    const int mid = y + size / 2;
    const int tip = back ? x + size / 3 : x + size * 2 / 3;
    const int tail = back ? x + size * 2 / 3 : x + size / 3;
    const int reach = size / 4;
    stroke(to, tail, mid - reach, tip, mid, 3, colour);
    stroke(to, tail, mid + reach, tip, mid, 3, colour);
}

void draw_check(Canvas &to, int x, int y, int size, uint8_t colour)
{
    stroke(to, x + size / 5, y + size / 2, x + size * 5 / 12, y + size * 7 / 10, 3, colour);
    stroke(to, x + size * 5 / 12, y + size * 7 / 10, x + size * 4 / 5, y + size * 3 / 10, 3,
           colour);
}

void draw_close(Canvas &to, int x, int y, int size, uint8_t colour)
{
    stroke(to, x + size / 4, y + size / 4, x + size * 3 / 4, y + size * 3 / 4, 3, colour);
    stroke(to, x + size * 3 / 4, y + size / 4, x + size / 4, y + size * 3 / 4, 3, colour);
}

void draw_menu(Canvas &to, int x, int y, int size, uint8_t colour)
{
    for (int i = 0; i < 3; ++i) {
        const int row = y + size / 4 + i * (size / 4);
        stroke(to, x + size / 5, row, x + size * 4 / 5, row, 3, colour);
    }
}

}  // namespace

void stroke(Canvas &to, int x0, int y0, int x1, int y1, int thick, uint8_t colour) noexcept
{
    const float dx = (float)(x1 - x0);
    const float dy = (float)(y1 - y0);
    const float len = sqrtf(dx * dx + dy * dy);
    const int steps = (int)(len * 2.0f) + 1;
    const int r = thick / 2;
    for (int i = 0; i <= steps; ++i) {
        const float t = (float)i / (float)steps;
        to.disc(x0 + (int)(dx * t), y0 + (int)(dy * t), r, colour);
    }
}

void wifi_bars(Canvas &to, int x, int y, int size, int level, uint8_t colour,
               uint8_t rest) noexcept
{
    bars_of(to, x, y, size, level, colour, rest);
}

void icon(Canvas &to, int x, int y, int size, Icon which, uint8_t colour) noexcept
{
    switch (which) {
        case Icon::Wifi: draw_wifi(to, x, y, size, colour); break;
        case Icon::Lock: draw_lock(to, x, y, size, colour); break;
        case Icon::Person: draw_person(to, x, y, size, colour); break;
        case Icon::PersonAdd: draw_person_add(to, x, y, size, colour); break;
        case Icon::Keyboard: draw_keyboard(to, x, y, size, colour); break;
        case Icon::Backspace: draw_backspace(to, x, y, size, colour); break;
        case Icon::List: draw_list(to, x, y, size, colour); break;
        case Icon::Device: draw_device(to, x, y, size, colour); break;
        case Icon::Brightness: draw_brightness(to, x, y, size, colour); break;
        case Icon::Volume: draw_volume(to, x, y, size, colour); break;
        case Icon::Chevron: draw_chevron(to, x, y, size, colour, false); break;
        case Icon::Back: draw_chevron(to, x, y, size, colour, true); break;
        case Icon::Check: draw_check(to, x, y, size, colour); break;
        case Icon::Close: draw_close(to, x, y, size, colour); break;
        case Icon::Menu: draw_menu(to, x, y, size, colour); break;
        default: break;
    }
}

void icon_tile(Canvas &to, int x, int y, int size, Icon which, uint8_t tint) noexcept
{
    to.card(x, y, size, size, kTileRadius, tint);
    const int inset = size / 5;
    icon(to, x + inset, y + inset, size - 2 * inset, which, DRV_LCD_SURFACE);
}

void card(Canvas &to, int x, int y, int w, int h) noexcept
{
    to.card(x, y, w, h, theme::kRadius, DRV_LCD_SURFACE);
}

void divider(Canvas &to, int x, int y, int w) noexcept
{
    const int inset = kRowPad + kTile + kRowPad;
    to.fill(x + inset, y, w - inset - kRowPad, 1, DRV_LCD_LINE);
}

void row(Canvas &to, int x, int y, int w, int h, const Row &what, bool pressed) noexcept
{
    if (pressed) {
        to.card(x, y, w, h, theme::kRadiusS, DRV_LCD_SURFACE_HI);
    }
    int pen = x + kRowPad;
    const int mid = y + (h - kTile) / 2;
    if (what.bars >= 0) {
        bars_of(to, pen + kTile / 4, mid + kTile / 6, kTile * 2 / 3, what.bars, DRV_LCD_ACCENT,
                DRV_LCD_LINE);
        pen += kTile + kRowPad;
    } else if (what.glyph != Icon::None) {
        icon_tile(to, pen, mid, kTile, what.glyph, what.tint);
        pen += kTile + kRowPad;
    }
    int right = x + w - kRowPad;
    if (what.chevron) {
        right -= kChevronW;
        draw_chevron(to, right, mid, kTile, DRV_LCD_DIM, false);
        right -= theme::kGapS;
    }
    const int line = Canvas::centre_y(theme::Font::Body, y, h);
    int room = right - pen;
    if (what.value != nullptr) {
        // The value is the answer; a long name is the thing that gives way.
        const int wide = theme::text_width(theme::Font::Body, what.value);
        const int spare = room - kLabelFloor;
        const int given = wide < spare ? wide : spare;
        to.text(theme::Font::Body, right - given, line, given, what.value, DRV_LCD_DIM,
                Align::Right);
        right -= given + theme::kGapM;
        room = right - pen;
    }
    if (what.trail != Icon::None) {
        const int box = 20;
        right -= box;
        icon(to, right, y + (h - box) / 2, box, what.trail, DRV_LCD_DIM);
        room = right - pen - theme::kGapS;
    }
    to.text(theme::Font::Body, pen, line, room, what.label, what.label_colour);
}

void slider_row(Canvas &to, int x, int y, int w, int h, Icon which, uint8_t tint, int percent,
                uint8_t colour) noexcept
{
    icon_tile(to, x + kRowPad, y + (h - kTile) / 2, kTile, which, tint);
    const int track_x = x + kRowPad + kTile + kRowPad;
    const int track_w = w - (track_x - x) - kRowPad - kKnobR;
    const int track_y = y + (h - kTrackH) / 2;
    to.card(track_x, track_y, track_w, kTrackH, kTrackH / 2, DRV_LCD_LINE);
    const int lit = track_w * clampi(percent, 0, 100) / 100;
    if (lit > 0) {
        to.card(track_x, track_y, lit, kTrackH, kTrackH / 2, colour);
    }
    to.disc(track_x + lit, track_y + kTrackH / 2, kKnobR, DRV_LCD_SURFACE);
    to.ring(track_x + lit, track_y + kTrackH / 2, kKnobR, 2, DRV_LCD_LINE);
}

int slider_percent(int x, int row_x, int row_w) noexcept
{
    const int track_x = row_x + kRowPad + kTile + kRowPad;
    const int track_w = row_w - (track_x - row_x) - kRowPad - kKnobR;
    if (track_w <= 0) {
        return 0;
    }
    return clampi((x - track_x) * 100 / track_w, 0, 100);
}

void key_cap(Canvas &to, int x, int y, int w, int h, const char *label, Icon glyph, bool down,
             bool muted) noexcept
{
    const uint8_t face = down ? DRV_LCD_ACCENT : (muted ? DRV_LCD_SURFACE_HI : DRV_LCD_SURFACE);
    const uint8_t ink = down ? DRV_LCD_SURFACE : DRV_LCD_INK;
    to.card(x, y, w, h, kKeyRadius, face);
    if (glyph != Icon::None) {
        const int box = h * 2 / 3;
        icon(to, x + (w - box) / 2, y + (h - box) / 2, box, glyph, ink);
        return;
    }
    to.text(theme::Font::Body, x, Canvas::centre_y(theme::Font::Body, y, h), w, label, ink,
            Align::Centre);
}

void button(Canvas &to, int x, int y, int w, int h, const char *label, uint8_t face, uint8_t ink,
            bool pressed) noexcept
{
    to.card(x, y, w, h, h / 2, pressed ? DRV_LCD_SURFACE_HI : face);
    to.text(theme::Font::Strong, x + theme::kGapM, Canvas::centre_y(theme::Font::Strong, y, h),
            w - 2 * theme::kGapM, label, ink, Align::Centre);
}

// The chevron overlays the left edge rather than taking width off both sides,
// which keeps a long title centred on the panel and whole.
void header(Canvas &to, const char *title, bool back) noexcept
{
    const int y = theme::kBarH;
    if (back) {
        draw_chevron(to, kBackX, y, kBackBox, DRV_LCD_ACCENT, true);
    }
    to.text(theme::Font::Title, theme::kGutter, Canvas::centre_y(theme::Font::Title, y, kBackBox),
            APP_LCD_H_RES - 2 * theme::kGutter, title, DRV_LCD_INK, Align::Centre);
}

bool on_back(int x, int y) noexcept
{
    return x >= 0 && x < kBackX + kBackBox + theme::kGapS && y >= theme::kBarH - theme::kGapS &&
           y < theme::kBarH + kBackBox + theme::kGapS;
}

void group_label(Canvas &to, int x, int y, int w, const char *text) noexcept
{
    to.text(theme::Font::Caption, x + theme::kGapM, y, w, text, DRV_LCD_DIM);
}

}  // namespace widgets
}  // namespace ui
