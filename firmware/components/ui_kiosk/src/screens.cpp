#include "screens.hpp"

#include <stdio.h>
#include <string.h>
#include <time.h>

namespace ui {

namespace {

constexpr int kBarH = 34;
constexpr int kGuideW = 176;
constexpr int kGuideH = 220;
constexpr int kGuideX = (APP_LCD_H_RES - kGuideW) / 2;
constexpr int kGuideY = 120;
constexpr int kPromptY = kGuideY + kGuideH + 16;
constexpr int kBandH = 104;
constexpr int kBandY = APP_LCD_V_RES - kBandH - 8;
constexpr int kMenuW = 44;
constexpr int kRowH = 58;
constexpr int kRowGap = 12;
constexpr int kPad = 16;
constexpr int kRadius = 10;
constexpr int kEdge = 2;
constexpr int kRingR = 30;
constexpr int kSamples = 3;
constexpr int64_t kSampleGapMs = 400;
constexpr uint32_t kFirstEmployee = 1;

ScreenManager s_manager;
EnrolRequest s_request;

void button(Canvas &to, int x, int y, int w, int h, const char *label, uint8_t tone, bool held)
{
    if (held) {
        to.fill(x, y, w, h, DRV_LCD_EDGE);
    }
    to.rounded(x, y, w, h, kRadius, kEdge, tone);
    to.text_centred_in(x, w, y + (h - Canvas::line_height()) / 2, label, DRV_LCD_INK);
}

bool inside(int x, int y, int bx, int by, int bw, int bh)
{
    return x >= bx && x < bx + bw && y >= by && y < by + bh;
}

void clock_text(char *out, size_t cap)
{
    const time_t now = time(nullptr);
    struct tm parts;
    localtime_r(&now, &parts);
    snprintf(out, cap, "%02d:%02d", parts.tm_hour, parts.tm_min);
}

void top_bar(Canvas &to, const char *right)
{
    char now[8] = { 0 };
    clock_text(now, sizeof(now));
    to.text(kPad, 6, now, DRV_LCD_INK);
    if (right != nullptr) {
        to.text(APP_LCD_H_RES - kPad - Canvas::text_width(right), 6, right, DRV_LCD_INK);
    }
}

// Corners, not an outline: a thirtieth of the cells, and the shape every
// camera app uses for "put it here" (KEHOACH 4.5.5h).
void guide(Canvas &to, uint8_t tone, const char *prompt)
{
    const int arm = 38;
    const int thick = 4;
    const int x2 = kGuideX + kGuideW;
    const int y2 = kGuideY + kGuideH;
    to.fill(kGuideX, kGuideY, arm, thick, tone);
    to.fill(kGuideX, kGuideY, thick, arm, tone);
    to.fill(x2 - arm, kGuideY, arm, thick, tone);
    to.fill(x2 - thick, kGuideY, thick, arm, tone);
    to.fill(kGuideX, y2 - thick, arm, thick, tone);
    to.fill(kGuideX, y2 - arm, thick, arm, tone);
    to.fill(x2 - arm, y2 - thick, arm, thick, tone);
    to.fill(x2 - thick, y2 - arm, thick, arm, tone);
    if (prompt != nullptr) {
        to.text_centred(kPromptY, prompt, DRV_LCD_INK);
    }
}

void tick_mark(Canvas &to, int cx, int cy, uint8_t tone)
{
    const int arm = kRingR / 3;
    for (int i = 0; i < arm; ++i) {
        to.fill(cx - arm + i, cy + i, 6, 6, tone);
    }
    for (int i = 0; i < 2 * arm; ++i) {
        to.fill(cx + i, cy + arm - i, 6, 6, tone);
    }
}

void ring(Canvas &to, int cx, int cy, int radius, int thick, uint8_t tone)
{
    const int outer = radius * radius;
    const int inner = (radius - thick) * (radius - thick);
    for (int y = -radius; y <= radius; ++y) {
        for (int x = -radius; x <= radius; ++x) {
            const int at = x * x + y * y;
            if (at <= outer && at >= inner) {
                to.fill(cx + x, cy + y, 1, 1, tone);
            }
        }
    }
}

const char *refusal(app_ui_verdict_t verdict)
{
    switch (verdict) {
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

class ScanScreen final : public Screen {
public:
    bool on_touch(int x, int y, bool down) noexcept override
    {
        const bool on_menu = inside(x, y, APP_LCD_H_RES - kMenuW, 0, kMenuW, kBarH);
        if (down) {
            held_ = on_menu;
            return true;
        }
        const bool fire = held_ && on_menu;
        held_ = false;
        if (fire) {
            manager().go(ScreenId::Menu);
        }
        return true;
    }

    void paint(Canvas &to, const Sight &seen) noexcept override
    {
        top_bar(to, nullptr);
        button(to, APP_LCD_H_RES - kMenuW - 4, 2, kMenuW, kBarH - 4, "≡", DRV_LCD_INK, held_);

        uint8_t tone = DRV_LCD_INK;
        const char *prompt = "Đưa khuôn mặt vào khung";
        if (seen.verdict == APP_UI_GRANTED) {
            tone = DRV_LCD_ACCENT;
            prompt = nullptr;
        } else if (refusal(seen.verdict) != nullptr) {
            tone = DRV_LCD_WARN;
            prompt = nullptr;
        } else if (seen.face && !seen.close_enough) {
            tone = DRV_LCD_WARN;
            prompt = "Lại gần hơn";
        } else if (seen.verifying) {
            tone = DRV_LCD_WARN;
            prompt = "Giữ yên…";
        }
        guide(to, tone, prompt);

        if (seen.verdict == APP_UI_GRANTED) {
            granted(to, seen);
            return;
        }
        const char *line = refusal(seen.verdict);
        if (line != nullptr) {
            to.text_centred(kBandY + kBandH / 2 - Canvas::line_height() / 2, line, DRV_LCD_INK);
        }
    }

private:
    static void granted(Canvas &to, const Sight &seen) noexcept
    {
        char who[STORAGE_NAME_CAP];
        if (seen.name[0] != '\0') {
            snprintf(who, sizeof(who), "%s", seen.name);
        } else {
            snprintf(who, sizeof(who), "Mã %u", (unsigned)seen.employee_id);
        }
        const int cx = kPad + kRingR + 8;
        const int cy = kBandY + kBandH / 2;
        ring(to, cx, cy, kRingR + 1, 6, DRV_LCD_EDGE);
        ring(to, cx, cy, kRingR, 4, DRV_LCD_ACCENT);
        tick_mark(to, cx - 3, cy - 3, DRV_LCD_ACCENT);
        const int text_x = cx + kRingR + 16;
        const int block = 2 * Canvas::line_height() + 4;
        to.text(text_x, cy - block / 2, who, DRV_LCD_INK);
        to.text(text_x, cy - block / 2 + Canvas::line_height() + 4, "Đã chấm công", DRV_LCD_ACCENT);
    }

    bool held_ = false;
};

class MenuScreen final : public Screen {
public:
    bool on_touch(int x, int y, bool down) noexcept override
    {
        const int hit = row_at(x, y);
        if (down) {
            held_ = hit;
            return true;
        }
        const int fire = held_ == hit ? hit : -1;
        held_ = -1;
        switch (fire) {
            case 0:
                manager().go(ScreenId::Enrol);
                break;
            case 1:
                manager().go(ScreenId::People);
                break;
            case 2:
                manager().go(ScreenId::Settings);
                break;
            case 3:
                manager().go(ScreenId::Scan);
                break;
            default:
                break;
        }
        return true;
    }

    void paint(Canvas &to, const Sight &seen) noexcept override
    {
        (void)seen;
        to.fill(0, 0, APP_LCD_H_RES, APP_LCD_V_RES, DRV_LCD_EDGE);
        top_bar(to, nullptr);
        to.text_centred(kBarH + 18, "Quản lý", DRV_LCD_INK);
        for (int i = 0; i < kRows; ++i) {
            button(to, kPad, row_y(i), APP_LCD_H_RES - 2 * kPad, kRowH, kLabels[i],
                   i == kRows - 1 ? DRV_LCD_INK : DRV_LCD_ACCENT, held_ == i);
        }
    }

private:
    static constexpr int kRows = 4;
    static constexpr const char *kLabels[kRows] = { "Thêm người", "Danh sách", "Cài đặt",
                                                    "Đóng" };

    static int row_y(int i) noexcept { return kBarH + 60 + i * (kRowH + kRowGap); }

    static int row_at(int x, int y) noexcept
    {
        for (int i = 0; i < kRows; ++i) {
            if (inside(x, y, kPad, row_y(i), APP_LCD_H_RES - 2 * kPad, kRowH)) {
                return i;
            }
        }
        return -1;
    }

    int held_ = -1;
};

class EnrolScreen final : public Screen {
public:
    void on_enter() noexcept override
    {
        typed_[0] = '\0';
        held_ = -1;
    }

    bool on_touch(int x, int y, bool down) noexcept override
    {
        const int key = key_at(x, y);
        if (down) {
            held_ = key;
            return true;
        }
        const int fire = held_ == key ? key : -1;
        held_ = -1;
        if (fire < 0) {
            return true;
        }
        press(fire);
        return true;
    }

    void paint(Canvas &to, const Sight &seen) noexcept override
    {
        (void)seen;
        to.fill(0, 0, APP_LCD_H_RES, APP_LCD_V_RES, DRV_LCD_EDGE);
        top_bar(to, nullptr);
        to.text(kPad, kBarH + 10, "Tên người mới", DRV_LCD_INK);
        to.rounded(kPad, kBarH + 42, APP_LCD_H_RES - 2 * kPad, 44, kRadius, kEdge, DRV_LCD_ACCENT);
        to.text(kPad + 12, kBarH + 42 + (44 - Canvas::line_height()) / 2,
                typed_[0] != '\0' ? typed_ : "…", DRV_LCD_INK);
        for (int i = 0; i < kKeys; ++i) {
            char label[8] = { 0 };
            snprintf(label, sizeof(label), "%c", kRowsText[i]);
            button(to, key_x(i), key_y(i), kKeyW, kKeyH, label, DRV_LCD_INK, held_ == i);
        }
        button(to, kPad, kFootY, 92, kRowH, "Xoá", DRV_LCD_INK, held_ == kBack);
        button(to, kPad + 100, kFootY, 92, kRowH, "Huỷ", DRV_LCD_INK, held_ == kCancel);
        button(to, kPad + 200, kFootY, APP_LCD_H_RES - 2 * kPad - 200, kRowH, "OK",
               DRV_LCD_ACCENT, held_ == kOk);
    }

private:
    static constexpr int kCols = 7;
    static constexpr int kKeys = 28;
    static constexpr int kKeyW = 40;
    static constexpr int kKeyH = 40;
    static constexpr int kKeyGap = 4;
    static constexpr int kKeyTop = 150;
    static constexpr int kFootY = APP_LCD_V_RES - kRowH - kPad;
    static constexpr int kBack = 100;
    static constexpr int kCancel = 101;
    static constexpr int kOk = 102;
    static constexpr const char *kRowsText = "ABCDEFGHIJKLMNOPQRSTUVWXYZ -";

    static int key_x(int i) noexcept
    {
        const int left = (APP_LCD_H_RES - (kCols * kKeyW + (kCols - 1) * kKeyGap)) / 2;
        return left + (i % kCols) * (kKeyW + kKeyGap);
    }

    static int key_y(int i) noexcept { return kKeyTop + (i / kCols) * (kKeyH + kKeyGap); }

    static int key_at(int x, int y) noexcept
    {
        for (int i = 0; i < kKeys; ++i) {
            if (inside(x, y, key_x(i), key_y(i), kKeyW, kKeyH)) {
                return i;
            }
        }
        if (inside(x, y, kPad, kFootY, 92, kRowH)) {
            return kBack;
        }
        if (inside(x, y, kPad + 100, kFootY, 92, kRowH)) {
            return kCancel;
        }
        if (inside(x, y, kPad + 200, kFootY, APP_LCD_H_RES - 2 * kPad - 200, kRowH)) {
            return kOk;
        }
        return -1;
    }

    void press(int key) noexcept
    {
        const size_t at = strlen(typed_);
        if (key == kBack) {
            if (at > 0) {
                typed_[at - 1] = '\0';
            }
            return;
        }
        if (key == kCancel) {
            manager().go(ScreenId::Menu);
            return;
        }
        if (key == kOk) {
            if (at == 0) {
                return;
            }
            strlcpy(enrol_request().name, typed_, sizeof(enrol_request().name));
            manager().go(ScreenId::Capture);
            return;
        }
        if (at + 1 < sizeof(typed_)) {
            typed_[at] = kRowsText[key];
            typed_[at + 1] = '\0';
        }
    }

    char typed_[STORAGE_NAME_CAP] = { 0 };
    int held_ = -1;
};

class CaptureScreen final : public Screen {
public:
    void on_enter() noexcept override
    {
        kept_ = 0;
        since_ms_ = 0;
        arm();
    }

    bool on_touch(int x, int y, bool down) noexcept override
    {
        const bool on_cancel = inside(x, y, kPad, kFootY, APP_LCD_H_RES - 2 * kPad, kRowH);
        if (down) {
            held_ = on_cancel;
            return true;
        }
        const bool fire = held_ && on_cancel;
        held_ = false;
        if (fire) {
            enrol_request().waiting = false;
            manager().go(ScreenId::Menu);
        }
        return true;
    }

    bool tick(uint32_t dt_ms, const Sight &seen) noexcept override
    {
        (void)seen;
        since_ms_ += dt_ms;
        if (enrol_request().waiting || since_ms_ < kSampleGapMs) {
            return false;
        }
        ++kept_;
        if (kept_ >= kSamples) {
            manager().go(ScreenId::Scan);
            return true;
        }
        arm();
        return true;
    }

    void paint(Canvas &to, const Sight &seen) noexcept override
    {
        top_bar(to, nullptr);
        to.text_centred(kBarH + 12, kAsk[kept_ < kSamples ? kept_ : kSamples - 1], DRV_LCD_INK);
        guide(to, DRV_LCD_WARN, nullptr);
        const int left = (APP_LCD_H_RES - (kSamples * 40 + (kSamples - 1) * 10)) / 2;
        for (int i = 0; i < kSamples; ++i) {
            const int x = left + i * 50;
            to.rounded(x, kPromptY, 40, 14, 6, 2, DRV_LCD_INK);
            if (i < kept_) {
                to.fill(x + 3, kPromptY + 3, 34, 8, DRV_LCD_ACCENT);
            }
        }
        (void)seen;
        button(to, kPad, kFootY, APP_LCD_H_RES - 2 * kPad, kRowH, "Huỷ", DRV_LCD_INK, held_);
    }

private:
    static constexpr int kFootY = APP_LCD_V_RES - kRowH - kPad;
    static constexpr const char *kAsk[kSamples] = { "Nhìn thẳng vào camera",
                                                    "Quay nhẹ sang trái",
                                                    "Quay nhẹ sang phải" };

    void arm() noexcept
    {
        since_ms_ = 0;
        enrol_request().employee_id = kFirstEmployee;
        enrol_request().template_idx = (uint16_t)kept_;
        enrol_request().waiting = true;
    }

    int kept_ = 0;
    int64_t since_ms_ = 0;
    bool held_ = false;
};

class ListScreen final : public Screen {
public:
    explicit ListScreen(const char *title) noexcept : title_(title) {}

    bool on_touch(int x, int y, bool down) noexcept override
    {
        const bool on_back = inside(x, y, kPad, kFootY, APP_LCD_H_RES - 2 * kPad, kRowH);
        if (down) {
            held_ = on_back;
            return true;
        }
        const bool fire = held_ && on_back;
        held_ = false;
        if (fire) {
            manager().go(ScreenId::Menu);
        }
        return true;
    }

    void paint(Canvas &to, const Sight &seen) noexcept override
    {
        (void)seen;
        to.fill(0, 0, APP_LCD_H_RES, APP_LCD_V_RES, DRV_LCD_EDGE);
        top_bar(to, nullptr);
        to.text_centred(kBarH + 18, title_, DRV_LCD_INK);
        for (int i = 0; i < lines_; ++i) {
            to.text(kPad, kBarH + 60 + i * (Canvas::line_height() + 8), line_[i], DRV_LCD_INK);
        }
        button(to, kPad, kFootY, APP_LCD_H_RES - 2 * kPad, kRowH, "Quay lại", DRV_LCD_INK, held_);
    }

    void say(int at, const char *text) noexcept
    {
        if (at < kLines) {
            strlcpy(line_[at], text, sizeof(line_[at]));
            lines_ = at + 1 > lines_ ? at + 1 : lines_;
        }
    }

private:
    static constexpr int kLines = 8;
    static constexpr int kFootY = APP_LCD_V_RES - kRowH - kPad;

    const char *title_;
    char line_[kLines][40] = {};
    int lines_ = 0;
    bool held_ = false;
};

ScanScreen s_scan;
MenuScreen s_menu;
EnrolScreen s_enrol;
CaptureScreen s_capture;
ListScreen s_people("Danh sách");
ListScreen s_settings("Cài đặt");

}  // namespace

void ScreenManager::go(ScreenId id) noexcept
{
    if (id == at_ || screens_[(int)id] == nullptr) {
        return;
    }
    screens_[(int)at_]->on_exit();
    at_ = id;
    screens_[(int)at_]->on_enter();
}

ScreenManager &manager() noexcept
{
    return s_manager;
}

EnrolRequest &enrol_request() noexcept
{
    return s_request;
}

Screen *scan_screen() noexcept
{
    return &s_scan;
}

Screen *menu_screen() noexcept
{
    return &s_menu;
}

Screen *enrol_screen() noexcept
{
    return &s_enrol;
}

Screen *capture_screen() noexcept
{
    return &s_capture;
}

Screen *people_screen() noexcept
{
    return &s_people;
}

Screen *settings_screen() noexcept
{
    return &s_settings;
}

}  // namespace ui
