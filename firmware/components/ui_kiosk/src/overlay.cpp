#include "overlay.hpp"

#include <stdio.h>
#include <string.h>

#include "app_config.h"
#include "esp_heap_caps.h"
#include "kiosk_sans_22.h"

namespace ui {

namespace {

constexpr int kBandTop = APP_LCD_V_RES - 112;
constexpr int kLineGap = 4;
constexpr int kIdCap = 24;

// RGB565 the panel wants high byte first, and the preview path does not swap
// on the way out (KEHOACH 4.5.5h).
constexpr uint16_t wire(uint16_t rgb565)
{
    return (uint16_t)((rgb565 >> 8) | (rgb565 << 8));
}

constexpr uint16_t kWhite = 0xFFFF;
constexpr uint16_t kMint = 0x27EC;
constexpr uint16_t kShadow = 0x0000;

// Vietnamese reaches the glass from here until an i18n file exists (CLAUDE 3).
const char *say(app_ui_verdict_t verdict)
{
    switch (verdict) {
        case APP_UI_GRANTED:
            return "Chấm công thành công";
        case APP_UI_SPOOF:
            return "Ảnh giả, mời thử lại";
        case APP_UI_UNKNOWN:
            return "Chưa có trong hệ thống";
        case APP_UI_DENIED:
            return "Chưa nhận được, thử lại";
        default:
            return nullptr;
    }
}

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

int width_of(const char *text)
{
    int width = 0;
    while (*text != '\0') {
        const kiosk_glyph_t *glyph = glyph_of(code_point(&text));
        width += glyph != nullptr ? glyph->adv : 0;
    }
    return width;
}

void stamp(uint8_t *cover, int rows, int pen_x, int top, const char *text, uint8_t value)
{
    while (*text != '\0') {
        const kiosk_glyph_t *glyph = glyph_of(code_point(&text));
        if (glyph == nullptr) {
            continue;
        }
        const uint8_t *bits = &kiosk_sans_22_bitmap[glyph->at];
        const int stride = (glyph->w + 7) / 8;
        for (int y = 0; y < glyph->h; ++y) {
            const int row = top + glyph->off_y + y;
            if (row < 0 || row >= rows) {
                continue;
            }
            for (int x = 0; x < glyph->w; ++x) {
                const int col = pen_x + glyph->off_x + x;
                if (col < 0 || col >= APP_LCD_H_RES) {
                    continue;
                }
                if ((bits[y * stride + x / 8] & (0x80u >> (x % 8))) == 0) {
                    continue;
                }
                uint8_t *cell = &cover[(size_t)row * APP_LCD_H_RES + col];
                if (value == DRV_LCD_INK || *cell == 0) {
                    *cell = value;
                }
            }
        }
        pen_x += glyph->adv;
    }
}

// Text over live video carries its own contrast: every glyph is stamped once
// around itself in shadow, then once on top in ink.
void write_line(uint8_t *cover, int rows, int top, const char *text)
{
    const int pen = (APP_LCD_H_RES - width_of(text)) / 2;
    for (int dy = -1; dy <= 1; ++dy) {
        for (int dx = -1; dx <= 1; ++dx) {
            if (dx != 0 || dy != 0) {
                stamp(cover, rows, pen + dx, top + dy, text, DRV_LCD_EDGE);
            }
        }
    }
    stamp(cover, rows, pen, top, text, DRV_LCD_INK);
}

constexpr int kBoxEdgePx = 3;
constexpr uint16_t kSteel = 0x8410;

}  // namespace

bool OverlayBuilder::set_face(bool found, const float box[4], int frame_width,
                              int frame_height) noexcept
{
    int16_t panel[4] = { 0, 0, 0, 0 };
    const bool on_panel = found && drv_lcd_frame_to_panel(frame_width, frame_height, box, panel);
    if (!on_panel) {
        const bool changed = face_found_;
        face_found_ = false;
        return changed;
    }
    if (face_found_ && memcmp(panel, face_, sizeof(panel)) == 0) {
        return false;
    }
    memcpy(face_, panel, sizeof(face_));
    face_found_ = true;
    return true;
}

bool OverlayBuilder::set_others(const float *boxes, int count, int frame_width,
                                int frame_height) noexcept
{
    int16_t panel[kOthers][4] = {};
    int kept = 0;
    for (int i = 0; i < count && kept < kOthers; ++i) {
        if (drv_lcd_frame_to_panel(frame_width, frame_height, boxes + i * 4, panel[kept])) {
            ++kept;
        }
    }
    if (kept == others_ && memcmp(panel, other_, sizeof(int16_t) * 4 * kept) == 0) {
        return false;
    }
    memcpy(other_, panel, sizeof(other_));
    others_ = kept;
    return true;
}

esp_err_t OverlayBuilder::init() noexcept
{
    const size_t bytes = (size_t)APP_LCD_H_RES * kBandHeight;
    for (int i = 0; i < kSlots; ++i) {
        cover_[i] = static_cast<uint8_t *>(heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM));
        if (cover_[i] == nullptr) {
            return ESP_ERR_NO_MEM;
        }
        memset(cover_[i], 0, bytes);
    }
    return ESP_OK;
}

void OverlayBuilder::draw(const char *line, const char *under) noexcept
{
    uint8_t *cover = cover_[next_];
    memset(cover, 0, (size_t)APP_LCD_H_RES * kBandHeight);
    const int lines = under != nullptr ? 2 : 1;
    const int block = lines * kiosk_sans_22_line_h + (lines - 1) * kLineGap;
    int top = (kBandHeight - block) / 2;
    write_line(cover, kBandHeight, top, line);
    if (under != nullptr) {
        top += kiosk_sans_22_line_h + kLineGap;
        write_line(cover, kBandHeight, top, under);
    }
    shown_ = next_;
    next_ = (next_ + 1) % kSlots;
}

bool OverlayBuilder::set_verdict(app_ui_verdict_t verdict, uint32_t employee_id) noexcept
{
    if (verdict == verdict_ && employee_id == employee_id_) {
        return false;
    }
    verdict_ = verdict;
    employee_id_ = employee_id;
    const char *line = say(verdict);
    if (line == nullptr) {
        shown_ = -1;
        return true;
    }
    char id[kIdCap] = { 0 };
    if (verdict == APP_UI_GRANTED && employee_id != 0) {
        snprintf(id, sizeof(id), "Mã %u", (unsigned)employee_id);
    }
    draw(line, id[0] != '\0' ? id : nullptr);
    return true;
}

void OverlayBuilder::build(drv_lcd_overlay_t *out) noexcept
{
    memset(out, 0, sizeof(*out));
    if (face_found_) {
        out->box[0].x1 = face_[0];
        out->box[0].y1 = face_[1];
        out->box[0].x2 = face_[2];
        out->box[0].y2 = face_[3];
        out->box[0].rgb565 = wire(verdict_ == APP_UI_GRANTED ? kMint : kWhite);
        out->box[0].edge_px = kBoxEdgePx;
        out->boxes = 1;
    }
    // A thinner edge says the kiosk saw this face but is not working on it.
    for (int i = 0; i < others_ && out->boxes < DRV_LCD_OVERLAY_BOXES; ++i) {
        drv_lcd_box_t *box = &out->box[out->boxes];
        box->x1 = other_[i][0];
        box->y1 = other_[i][1];
        box->x2 = other_[i][2];
        box->y2 = other_[i][3];
        box->rgb565 = wire(kSteel);
        box->edge_px = 1;
        out->boxes = (uint8_t)(out->boxes + 1);
    }
    if (shown_ < 0) {
        return;
    }
    out->mask[0].x = 0;
    out->mask[0].y = kBandTop;
    out->mask[0].w = APP_LCD_H_RES;
    out->mask[0].h = kBandHeight;
    out->mask[0].cover = cover_[shown_];
    out->mask[0].ink_rgb565 = wire(verdict_ == APP_UI_GRANTED ? kMint : kWhite);
    out->mask[0].edge_rgb565 = wire(kShadow);
    out->masks = 1;
}

}  // namespace ui
