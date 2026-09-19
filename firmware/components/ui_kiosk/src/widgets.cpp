#include "widgets.hpp"

#include <math.h>

namespace ui {
namespace widgets {

namespace {

constexpr int kTile = 38;
constexpr int kTileRadius = 11;
constexpr int kRowPad = 14;
constexpr int kTrackH = 8;
constexpr int kKnobR = 13;
constexpr int kBackBox = 40;
constexpr int kBackX = 8;
constexpr int kKeyRadius = 8;
constexpr int kLabelFloor = 72;
constexpr int kSegmentW = 80;
constexpr int kSegmentH = 32;

int segment_x(int row_x, int row_w)
{
    return row_x + row_w - kRowPad - kSegmentW;
}

int clampi(int v, int low, int high)
{
    return v < low ? low : (v > high ? high : v);
}

// One band of a fan opening upwards, anti-aliased across its thickness. The
// hard ring test this replaces turned to mush anywhere under about 40 px.
void arc_band(Canvas &to, int cx, int cy, float radius, float thick, uint8_t colour)
{
    const int reach = (int)(radius + thick) + 1;
    for (int dy = -reach; dy <= 0; ++dy) {
        for (int dx = -reach; dx <= reach; ++dx) {
            const float ax = dx < 0 ? (float)-dx : (float)dx;
            // The fan spans about 100 degrees, so it reads as wifi and not as a
            // full ring with its bottom rubbed out.
            if (ax > (float)-dy * 1.2f) {
                continue;
            }
            const float d = sqrtf((float)(dx * dx + dy * dy));
            const float off = d - radius;
            const float over = thick * 0.5f - (off < 0.0f ? -off : off) + 0.5f;
            if (over <= 0.0f) {
                continue;
            }
            const uint8_t level = over >= 1.0f
                                      ? DRV_LCD_COVER_FULL
                                      : (uint8_t)(over * (float)DRV_LCD_COVER_FULL);
            to.put_cell(cx + dx, cy + dy, DRV_LCD_CELL(colour, level));
        }
    }
}

void fan_of(Canvas &to, int x, int y, int size, int level, uint8_t lit, uint8_t rest)
{
    const int cx = x + size / 2;
    const int cy = y + (int)((float)size * 0.80f);
    const float thick = (float)size * 0.11f + 1.0f;
    to.disc(cx, cy, (int)((float)size * 0.09f) + 1, level > 0 ? lit : rest);
    for (int band = 1; band <= 3; ++band) {
        arc_band(to, cx, cy, (float)size * (0.16f + 0.20f * (float)band), thick,
                 band < level ? lit : rest);
    }
}

void draw_wifi(Canvas &to, int x, int y, int size, uint8_t colour)
{
    fan_of(to, x, y, size, 4, colour, colour);
}

void draw_lock(Canvas &to, int x, int y, int size, uint8_t colour)
{
    const int body_h = size * 2 / 5;
    const int body_w = size * 3 / 5;
    const int bx = x + (size - body_w) / 2;
    const int by = y + size - body_h - size / 8;
    to.card(bx, by, body_w, body_h, 3, colour);
    // The shackle is a half ring on two legs, not a wedge: a quarter arc at this
    // size reads as a smudge sitting on a block.
    const int r = body_w * 2 / 5;
    const int cx = x + size / 2;
    const int cy = by - size / 6;
    for (int dy = -r; dy <= 0; ++dy) {
        for (int dx = -r; dx <= r; ++dx) {
            const float d = sqrtf((float)(dx * dx + dy * dy));
            if (d <= (float)r && d >= (float)(r - 2)) {
                to.fill(cx + dx, cy + dy, 1, 1, colour);
            }
        }
    }
    to.fill(cx - r, cy, 2, by - cy, colour);
    to.fill(cx + r - 1, cy, 2, by - cy, colour);
}

void draw_person(Canvas &to, int x, int y, int size, uint8_t colour)
{
    const int head = size / 5;
    to.disc(x + size / 2, y + size / 3, head, colour);
    const int body_w = size * 2 / 3;
    to.card(x + (size - body_w) / 2, y + size / 2 + 2, body_w, size / 3, size / 6, colour);
}

void draw_sliders(Canvas &to, int x, int y, int size, uint8_t colour)
{
    const int left = x + size / 6;
    const int right = x + size - size / 6;
    for (int i = 0; i < 2; ++i) {
        const int row = y + size / 3 + i * size / 3;
        stroke(to, left, row, right, row, 2, colour);
        to.disc(i == 0 ? right - size / 4 : left + size / 4, row, size / 8, colour);
    }
}

void draw_backspace(Canvas &to, int x, int y, int size, uint8_t colour)
{
    const int h = size * 2 / 5;
    const int top = y + (size - h) / 2;
    const int mid = top + h / 2;
    const int tip = x + size / 8;
    const int body = x + size / 2 - size / 8;
    to.card(body, top, x + size - size / 8 - body, h, 2, colour);
    for (int i = 0; i <= body - tip; ++i) {
        const int reach = (h / 2) * i / (body - tip);
        to.fill(tip + i, mid - reach, 1, 2 * reach + 1, colour);
    }
    const int cx = body + (x + size - size / 8 - body) / 2;
    const int arm = h / 4;
    stroke(to, cx - arm, mid - arm, cx + arm, mid + arm, 2, DRV_LCD_GROUND);
    stroke(to, cx + arm, mid - arm, cx - arm, mid + arm, 2, DRV_LCD_GROUND);
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

void draw_globe(Canvas &to, int x, int y, int size, uint8_t colour)
{
    const int r = size / 2 - 1;
    const int cx = x + size / 2;
    const int cy = y + size / 2;
    to.ring(cx, cy, r, 2, colour);
    stroke(to, cx - r, cy, cx + r, cy, 2, colour);
    to.outline(cx - r / 2, cy - r, r, 2 * r, r / 2, 2, colour);
}

void draw_brightness(Canvas &to, int x, int y, int size, uint8_t colour)
{
    const int cx = x + size / 2;
    const int cy = y + size / 2;
    to.disc(cx, cy, size / 5, colour);
    // Rays start well clear of the core: closer together they read as a blot.
    const float from = (float)size * 0.32f;
    const float reach = (float)size * 0.5f;
    for (int i = 0; i < 8; ++i) {
        const float a = (float)i * 3.14159265f / 4.0f;
        const float ux = cosf(a);
        const float uy = sinf(a);
        stroke(to, cx + (int)(ux * from), cy + (int)(uy * from), cx + (int)(ux * reach),
               cy + (int)(uy * reach), 2, colour);
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

void draw_back(Canvas &to, int x, int y, int size, uint8_t colour)
{
    const int mid = y + size / 2;
    const int tip = x + size / 3;
    const int tail = x + size * 2 / 3;
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
    fan_of(to, x, y, size, level, colour, rest);
}

void icon(Canvas &to, int x, int y, int size, Icon which, uint8_t colour) noexcept
{
    switch (which) {
        case Icon::Wifi: draw_wifi(to, x, y, size, colour); break;
        case Icon::Lock: draw_lock(to, x, y, size, colour); break;
        case Icon::Person: draw_person(to, x, y, size, colour); break;
        case Icon::PersonAdd: draw_person_add(to, x, y, size, colour); break;
        case Icon::Keyboard: draw_keyboard(to, x, y, size, colour); break;
        case Icon::Sliders: draw_sliders(to, x, y, size, colour); break;
        case Icon::Backspace: draw_backspace(to, x, y, size, colour); break;
        case Icon::List: draw_list(to, x, y, size, colour); break;
        case Icon::Device: draw_device(to, x, y, size, colour); break;
        case Icon::Globe: draw_globe(to, x, y, size, colour); break;
        case Icon::Brightness: draw_brightness(to, x, y, size, colour); break;
        case Icon::Volume: draw_volume(to, x, y, size, colour); break;
        case Icon::Back: draw_back(to, x, y, size, colour); break;
        case Icon::Check: draw_check(to, x, y, size, colour); break;
        case Icon::Menu: draw_menu(to, x, y, size, colour); break;
        default: break;
    }
}

void icon_tile(Canvas &to, int x, int y, int size, Icon which, uint8_t tint) noexcept
{
    to.card(x, y, size, size, kTileRadius, tint);
    const int inset = size / 6;
    icon(to, x + inset, y + inset, size - 2 * inset, which, DRV_LCD_INK);
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
        fan_of(to, pen + kTile / 6, mid + kTile / 6, kTile * 2 / 3, what.bars, DRV_LCD_ACCENT,
               DRV_LCD_LINE);
        pen += kTile + kRowPad;
    } else if (what.glyph != Icon::None) {
        icon_tile(to, pen, mid, kTile, what.glyph, what.tint);
        pen += kTile + kRowPad;
    }
    int right = x + w - kRowPad;
    const int line = Canvas::centre_y(theme::Font::Body, y, h);
    int room = right - pen;
    if (what.value != nullptr) {
        // A label that already fits keeps its width; only a long one gives way,
        // and never below what still reads as a name.
        const int wide = theme::text_width(theme::Font::Body, what.value);
        const int named = theme::text_width(theme::Font::Body, what.label);
        const int after = room - named - theme::kGapM;
        const int floor_left = room - kLabelFloor;
        const int spare = after > floor_left ? after : floor_left;
        const int given = wide < spare ? wide : spare;
        to.text(theme::Font::Body, right - given, line, given, what.value, DRV_LCD_DIM,
                Align::Right);
        right -= given + theme::kGapM;
        room = right - pen;
    }
    if (what.trail != Icon::None) {
        const int box = 26;
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

void segment_row(Canvas &to, int x, int y, int w, int h, Icon which, uint8_t tint,
                 const char *label, const char *left, const char *right, bool right_on,
                 bool pressed) noexcept
{
    if (pressed) {
        to.card(x, y, w, h, theme::kRadiusS, DRV_LCD_SURFACE_HI);
    }
    icon_tile(to, x + kRowPad, y + (h - kTile) / 2, kTile, which, tint);
    const int box = segment_x(x, w);
    const int top = y + (h - kSegmentH) / 2;
    const int half = kSegmentW / 2;
    const int line = Canvas::centre_y(theme::Font::Caption, top, kSegmentH);
    to.card(box, top, kSegmentW, kSegmentH, kSegmentH / 2, DRV_LCD_LINE);
    to.card(right_on ? box + half : box, top, half, kSegmentH, kSegmentH / 2, DRV_LCD_ACCENT);
    to.text(theme::Font::Caption, box, line, half, left,
            right_on ? DRV_LCD_DIM : DRV_LCD_INK, Align::Centre);
    to.text(theme::Font::Caption, box + half, line, half, right,
            right_on ? DRV_LCD_INK : DRV_LCD_DIM, Align::Centre);
    const int pen = x + kRowPad + kTile + kRowPad;
    to.text(theme::Font::Body, pen, Canvas::centre_y(theme::Font::Body, y, h),
            box - pen - theme::kGapM, label, DRV_LCD_INK);
}

int segment_hit(int x, int row_x, int row_w) noexcept
{
    const int box = segment_x(row_x, row_w);
    if (x < box || x >= box + kSegmentW) {
        return -1;
    }
    return x < box + kSegmentW / 2 ? 0 : 1;
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
    const uint8_t face = down ? DRV_LCD_ACCENT : (muted ? DRV_LCD_SURFACE : DRV_LCD_SURFACE_HI);
    const uint8_t ink = DRV_LCD_INK;
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
        draw_back(to, kBackX, y, kBackBox, DRV_LCD_ACCENT);
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
