#include "overlay.hpp"

#include <string.h>

#include "app_config.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"

namespace ui {

namespace {

constexpr int kBoxEdgePx = 3;
constexpr int kCardBorderPx = 3;
constexpr int kGlyphStrokePx = 10;
constexpr int kGlyphSidePx = 64;

// RGB565 the panel wants high byte first, and the preview path does not swap
// on the way out (KEHOACH 4.5.5h).
constexpr uint16_t wire(uint16_t rgb565)
{
    return (uint16_t)((rgb565 >> 8) | (rgb565 << 8));
}

constexpr uint16_t kWhite = 0xFFFF;
constexpr uint16_t kGreen = 0x07E0;
constexpr uint16_t kRed = 0xF800;
constexpr uint16_t kAmber = 0xFD20;
constexpr uint16_t kInk = 0x0841;

uint16_t accent_of(app_ui_verdict_t verdict)
{
    switch (verdict) {
        case APP_UI_GRANTED:
            return kGreen;
        case APP_UI_DENIED:
        case APP_UI_UNKNOWN:
            return kRed;
        case APP_UI_SPOOF:
            return kAmber;
        default:
            return kWhite;
    }
}

bool shows_card(app_ui_verdict_t verdict)
{
    return verdict != APP_UI_IDLE && verdict != APP_UI_SCANNING;
}

void fill_rect(uint16_t *pixels, int stride, int x, int y, int w, int h, int rows_cap,
               uint16_t colour)
{
    const int x1 = x > 0 ? x : 0;
    const int y1 = y > 0 ? y : 0;
    const int x2 = x + w < stride ? x + w : stride;
    const int y2 = y + h < rows_cap ? y + h : rows_cap;
    for (int row = y1; row < y2; ++row) {
        uint16_t *line = pixels + (size_t)row * stride;
        for (int col = x1; col < x2; ++col) {
            line[col] = colour;
        }
    }
}

// A stroke of its own thickness at every step, so the two glyphs below need no
// line algorithm and no rounding rules.
void stroke(uint16_t *pixels, int stride, int x0, int y0, int dx, int dy, int steps,
            uint16_t colour)
{
    for (int i = 0; i < steps; ++i) {
        fill_rect(pixels, stride, x0 + dx * i, y0 + dy * i, kGlyphStrokePx, kGlyphStrokePx,
                  OverlayBuilder::kCardHeight, colour);
    }
}

void draw_tick(uint16_t *pixels, int stride, int cx, int cy, uint16_t colour)
{
    const int arm = kGlyphSidePx / 3;
    stroke(pixels, stride, cx - arm, cy, 1, 1, arm, colour);
    stroke(pixels, stride, cx, cy + arm, 1, -1, 2 * arm, colour);
}

void draw_cross(uint16_t *pixels, int stride, int cx, int cy, uint16_t colour)
{
    const int arm = kGlyphSidePx / 2;
    stroke(pixels, stride, cx - arm, cy - arm, 1, 1, 2 * arm, colour);
    stroke(pixels, stride, cx - arm, cy + arm, 1, -1, 2 * arm, colour);
}

}  // namespace

esp_err_t OverlayBuilder::init() noexcept
{
    const size_t bytes = (size_t)kCardWidth * kCardHeight * sizeof(uint16_t);
    for (int i = 0; i < kCards; ++i) {
        card_[i] = static_cast<uint16_t *>(heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM));
        if (card_[i] == nullptr) {
            return ESP_ERR_NO_MEM;
        }
        memset(card_[i], 0, bytes);
    }
    return ESP_OK;
}

uint16_t *OverlayBuilder::card_pixels() noexcept
{
    return card_[shown_card_];
}

void OverlayBuilder::paint_card() noexcept
{
    uint16_t *pixels = card_[next_card_];
    const uint16_t accent = wire(accent_of(verdict_));
    fill_rect(pixels, kCardWidth, 0, 0, kCardWidth, kCardHeight, kCardHeight, accent);
    fill_rect(pixels, kCardWidth, kCardBorderPx, kCardBorderPx, kCardWidth - 2 * kCardBorderPx,
              kCardHeight - 2 * kCardBorderPx, kCardHeight, wire(kInk));
    const int cx = kCardWidth / 2 - kGlyphStrokePx / 2;
    const int cy = kCardHeight / 2 - kGlyphStrokePx / 2;
    if (verdict_ == APP_UI_GRANTED) {
        draw_tick(pixels, kCardWidth, cx, cy, accent);
    } else {
        draw_cross(pixels, kCardWidth, cx, cy, accent);
    }
    shown_card_ = next_card_;
    next_card_ = (next_card_ + 1) % kCards;
}

bool OverlayBuilder::set_face(bool found, const float box[4], int frame_width,
                              int frame_height) noexcept
{
    int16_t panel[4] = { 0, 0, 0, 0 };
    const bool on_panel =
        found && drv_lcd_frame_to_panel(frame_width, frame_height, box, panel);
    const int64_t now_us = esp_timer_get_time();
    if (!on_panel) {
        const bool expired = face_found_ && now_us - face_seen_us_ >= kFaceHoldUs;
        face_found_ = face_found_ && !expired;
        return expired;
    }
    face_seen_us_ = now_us;
    if (face_found_ && memcmp(panel, face_, sizeof(panel)) == 0) {
        return false;
    }
    memcpy(face_, panel, sizeof(face_));
    face_found_ = true;
    return true;
}

bool OverlayBuilder::set_verdict(app_ui_verdict_t verdict, uint32_t employee_id) noexcept
{
    if (verdict == verdict_ && employee_id == employee_id_) {
        return false;
    }
    const bool repaint = shows_card(verdict) && verdict != verdict_;
    verdict_ = verdict;
    employee_id_ = employee_id;
    if (repaint) {
        paint_card();
    }
    return true;
}

void OverlayBuilder::build(drv_lcd_overlay_t *out) noexcept
{
    memset(out, 0, sizeof(*out));
    if (shows_card(verdict_) && card_pixels() != nullptr) {
        out->card[0].x = (int16_t)((APP_LCD_H_RES - kCardWidth) / 2);
        out->card[0].y = (int16_t)((APP_LCD_V_RES - kCardHeight) / 2);
        out->card[0].w = kCardWidth;
        out->card[0].h = kCardHeight;
        out->card[0].pixels = card_pixels();
        out->cards = 1;
    }
    if (face_found_) {
        out->box[0].x1 = face_[0];
        out->box[0].y1 = face_[1];
        out->box[0].x2 = face_[2];
        out->box[0].y2 = face_[3];
        out->box[0].rgb565 = wire(accent_of(verdict_));
        out->box[0].edge_px = kBoxEdgePx;
        out->boxes = 1;
    }
}

}  // namespace ui
