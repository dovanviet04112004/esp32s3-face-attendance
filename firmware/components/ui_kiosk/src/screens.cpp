#include "screens.hpp"

#include <stdio.h>
#include <string.h>
#include <time.h>

namespace ui {

namespace {

constexpr int kBarH = 34;
constexpr int kGuideW = 240;
constexpr int kGuideH = 296;
constexpr int kGuideX = (APP_LCD_H_RES - kGuideW) / 2;
constexpr int kGuideY = 96;
constexpr int kPromptY = kGuideY + kGuideH + 16;
constexpr int kBandH = 104;
constexpr int kBandY = APP_LCD_V_RES - kBandH - 8;
constexpr int kMenuW = 44;
constexpr int kRowH = 58;
constexpr int kRowGap = 12;
constexpr int kPad = 16;
constexpr int kFootGap = 12;
constexpr int kRadius = 10;
constexpr int kEdge = 2;
constexpr int kRingR = 30;
constexpr int kSamples = 3;
constexpr int64_t kSampleGapMs = 400;
constexpr int64_t kDoneShowMs = 1800;
constexpr uint32_t kNewPerson = 0;        // main fills in the id (KEHOACH 4.5.5h.2)
// Measured on the board 14/09: facing the lens holds inside 0.05, a turn either
// way passes 0.44, and left is the negative one (KEHOACH 4.5.5h.2).
constexpr float kFrontalYaw = 0.10f;
constexpr float kTurnYaw = 0.20f;
constexpr float kTurnSign = -1.0f;
constexpr float kOpenYaw = 10.0f;
// Enters the wrong-way line here and leaves it at zero, so a jittering landmark
// cannot flicker the text (KEHOACH 4.5.5h.2 rule 3).
constexpr float kWrongYaw = 0.03f;
// A landmark spike lands in one detect, and every pose gate reads one detect.
constexpr int kYawVotes = 3;
constexpr int64_t kPoseHoldMs = 300;
constexpr int64_t kPoseWaitMs = 6000;
constexpr int64_t kSampleWaitMs = 15000;
constexpr int kGaugeSteps = 12;
constexpr int kSpoofGiveUp = 3;
constexpr int64_t kRefusalShowMs = 2500;
constexpr int kAskY = 40;
constexpr int kDotsY = 66;
constexpr int kGaugeY = 82;
constexpr int kHintY = 356;

ScreenManager s_manager;
EnrolRequest s_request;
RemoveRequest s_remove;
People s_people_list;
Networks s_networks;
JoinRequest s_join;

void button(Canvas &to, int x, int y, int w, int h, const char *label, uint8_t tone, bool held)
{
    if (held) {
        to.fill(x, y, w, h, DRV_LCD_EDGE);
    }
    to.rounded(x, y, w, h, kRadius, kEdge, tone);
    to.text_centred_in(x, w, y + (h - Canvas::line_height()) / 2, label, DRV_LCD_INK);
}

// Three bars, not a glyph: the 22 px table holds ASCII and Vietnamese only.
void hamburger(Canvas &to, int x, int y, int w, int h)
{
    const int bar_w = w / 2;
    const int bar_h = 3;
    const int gap = 5;
    const int left = x + (w - bar_w) / 2;
    int top = y + (h - (3 * bar_h + 2 * gap)) / 2;
    for (int i = 0; i < 3; ++i) {
        to.fill(left, top, bar_w, bar_h, DRV_LCD_INK);
        top += bar_h + gap;
    }
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
    const int arm = 52;
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

float median_of(const float *three)
{
    const float lo = three[0] < three[1] ? three[0] : three[1];
    const float hi = three[0] < three[1] ? three[1] : three[0];
    return three[2] < lo ? lo : (three[2] > hi ? hi : three[2]);
}

const char *prompt_for(ui_kiosk_stage_t stage)
{
    switch (stage) {
        case UI_KIOSK_STAGE_TOO_FAR:
            return "Lại gần hơn";
        case UI_KIOSK_STAGE_TOO_CLOSE:
            return "Lùi lại một chút";
        case UI_KIOSK_STAGE_WORKING:
            return "Đang nhận diện...";
        default:
            return "Đưa khuôn mặt vào khung";
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
    bool tick(uint32_t dt_ms, const Sight &seen) noexcept override
    {
        (void)dt_ms;
        // Any verdict silences the guidance until that face leaves or the machine
        // takes up somebody else; a refusal also stays on the glass (KEHOACH 4.5.5h.1).
        const bool same_face = seen.face && seen.track == track_;
        const bool answered = seen.verdict > APP_UI_SCANNING ||
                              (answered_ && same_face && seen.verdict != APP_UI_SCANNING);
        const bool carded = seen.verdict == APP_UI_GRANTED;
        const char *fresh = refusal(seen.verdict);
        const char *refused = carded ? nullptr : (fresh != nullptr ? fresh : (answered ? refused_ : nullptr));
        if (seen.verdict > APP_UI_SCANNING) {
            track_ = seen.track;
        }
        if (answered == answered_ && carded == carded_ && refused == refused_) {
            return false;
        }
        answered_ = answered;
        carded_ = carded;
        refused_ = refused;
        return true;
    }

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
        button(to, APP_LCD_H_RES - kMenuW - 4, 2, kMenuW, kBarH - 4, "", DRV_LCD_INK, held_);
        hamburger(to, APP_LCD_H_RES - kMenuW - 4, 2, kMenuW, kBarH - 4);

        uint8_t tone = DRV_LCD_INK;
        const char *prompt = "Đưa khuôn mặt vào khung";
        const char *line = refusal(seen.verdict);
        if (line == nullptr) {
            line = refused_;
        }
        if (line != nullptr) {
            tone = DRV_LCD_WARN;
            prompt = nullptr;
        } else if (answered_) {
            tone = DRV_LCD_ACCENT;
            prompt = nullptr;
        } else if (seen.stage == UI_KIOSK_STAGE_WORKING) {
            tone = seen.face ? DRV_LCD_ACCENT : DRV_LCD_INK;
            prompt = seen.face ? prompt_for(seen.stage) : prompt;
        } else if (seen.stage != UI_KIOSK_STAGE_NO_FACE) {
            tone = DRV_LCD_WARN;
            prompt = prompt_for(seen.stage);
        }
        guide(to, tone, prompt);

        if (line != nullptr) {
            to.text_centred(kBandY + kBandH / 2 - Canvas::line_height() / 2, line, DRV_LCD_INK);
            return;
        }
        // The card keeps its own clock; the latch above only silences guidance,
        // or a stamped face standing still would pin the card (KEHOACH 4.5.5h.1).
        if (seen.verdict == APP_UI_GRANTED) {
            granted(to, seen);
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
    bool answered_ = false;
    bool carded_ = false;
    const char *refused_ = nullptr;
    uint32_t track_ = 0;
};

class MenuScreen final : public Screen {
public:
    bool opaque() const noexcept override { return true; }

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
                manager().go(ScreenId::Wifi);
                break;
            case 3:
                manager().go(ScreenId::Settings);
                break;
            case 4:
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
        top_bar(to, nullptr);
        to.text_centred(kBarH + 18, "Quản lý", DRV_LCD_INK);
        for (int i = 0; i < kRows; ++i) {
            button(to, kPad, row_y(i), APP_LCD_H_RES - 2 * kPad, kRowH, kLabels[i],
                   i == kRows - 1 ? DRV_LCD_INK : DRV_LCD_ACCENT, held_ == i);
        }
    }

private:
    static constexpr int kRows = 5;
    static constexpr const char *kLabels[kRows] = { "Thêm người", "Danh sách", "Wi-Fi", "Cài đặt",
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
    bool opaque() const noexcept override { return true; }

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
    void on_enter() noexcept override { restart(); }

    bool on_touch(int x, int y, bool down) noexcept override
    {
        const int wide = APP_LCD_H_RES - 2 * kPad;
        const int half = failed_ ? (wide - kFootGap) / 2 : wide;
        const bool on_left = inside(x, y, kPad, kFootY, half, kRowH);
        const bool on_right = failed_ && inside(x, y, kPad + half + kFootGap, kFootY, half, kRowH);
        if (down) {
            held_ = on_left ? 1 : (on_right ? 2 : 0);
            return true;
        }
        const int fired = (held_ == 1 && on_left) ? 1 : ((held_ == 2 && on_right) ? 2 : 0);
        held_ = 0;
        if (fired == 1 && failed_) {
            restart();
            return true;
        }
        if (fired != 0) {
            enrol_request().waiting = false;
            manager().go(ScreenId::Menu);
        }
        return true;
    }

    bool tick(uint32_t dt_ms, const Sight &seen) noexcept override
    {
        feed(seen);
        since_ms_ += dt_ms;
        // The operator ends this screen, not a timer: the line naming who joined
        // the table has to survive a glance away (KEHOACH 4.5.5h.2).
        if (kept_ >= kSamples || failed_) {
            return false;
        }
        const bool was_refusing = refusing();
        refused_ms_ += dt_ms;
        if (was_refusing != refusing()) {
            return true;
        }
        if (took_) {
            if (since_ms_ < kSampleGapMs) {
                return false;
            }
            took_ = false;
            begin();
            return true;
        }
        wait_ms_ += dt_ms;
        // Liveness refusing every frame must not hold a person here, and taking
        // one anyway would write a spoof into the table (KEHOACH 4.5.5h.2).
        if (wait_ms_ >= kSampleWaitMs) {
            enrol_request().waiting = false;
            failed_ = true;
            since_ms_ = 0;
            return true;
        }
        if (!armed_) {
            watch(seen);
            pose_ms_ = posed(seen) ? pose_ms_ + (int64_t)dt_ms : 0;
            if (pose_ms_ >= kPoseHoldMs) {
                arm();
                return true;
            }
        }
        const bool turned_away = astray(seen);
        const int step = gauge(seen);
        if (step == step_ && turned_away == wrong_) {
            return false;
        }
        step_ = step;
        wrong_ = turned_away;
        return true;
    }

    // Asking takes a tick, landing takes a second and a half (KEHOACH 4.5.5d).
    void kept_one() noexcept
    {
        ++kept_;
        took_ = true;
        since_ms_ = 0;
    }

    bool done() const noexcept { return kept_ >= kSamples; }

    // The pipeline stops trying at the same count, so idling out the budget
    // after that only shows a pose prompt to a photograph (KEHOACH 4.5.5h.2).
    void refused_one() noexcept
    {
        ++spoofs_;
        refused_ms_ = 0;
        why_ = refusal(APP_UI_SPOOF);
        if (spoofs_ >= kSpoofGiveUp) {
            enrol_request().waiting = false;
            failed_ = true;
            since_ms_ = 0;
        }
    }

    bool refusing() const noexcept { return spoofs_ > 0 && refused_ms_ < kRefusalShowMs; }

    void paint(Canvas &to, const Sight &seen) noexcept override
    {
        top_bar(to, nullptr);
        if (failed_) {
            to.text_centred(kAskY, "Chưa lấy được mẫu", DRV_LCD_WARN);
            if (why_ != nullptr) {
                to.text_centred(kHintY, why_, DRV_LCD_INK);
            }
        } else if (done()) {
            char line[STORAGE_NAME_CAP + 16];
            snprintf(line, sizeof(line), "Đã thêm %.*s", STORAGE_NAME_CAP - 1,
                     enrol_request().name);
            to.text_centred(kAskY, line, DRV_LCD_ACCENT);
        } else if (refusing()) {
            char line[48];
            snprintf(line, sizeof(line), "%s · lần %d/%d", why_, spoofs_, kSpoofGiveUp);
            to.text_centred(kAskY, line, DRV_LCD_WARN);
        } else {
            to.text_centred(kAskY, kAsk[kept_], DRV_LCD_INK);
        }
        const int left = (APP_LCD_H_RES - (kSamples * 40 + (kSamples - 1) * 10)) / 2;
        for (int i = 0; i < kSamples; ++i) {
            const int x = left + i * 50;
            to.rounded(x, kDotsY, 40, 12, 6, 2, DRV_LCD_INK);
            if (i < kept_) {
                to.fill(x + 3, kDotsY + 3, 34, 6, DRV_LCD_ACCENT);
            }
        }
        guide(to, done() ? DRV_LCD_ACCENT : DRV_LCD_WARN, nullptr);
        if (done()) {
            button(to, kPad, kFootY, APP_LCD_H_RES - 2 * kPad, kRowH, "Xác nhận", DRV_LCD_ACCENT,
                   held_ == 1);
            return;
        }
        if (failed_) {
            const int half = (APP_LCD_H_RES - 2 * kPad - kFootGap) / 2;
            button(to, kPad, kFootY, half, kRowH, "Thử lại", DRV_LCD_ACCENT, held_ == 1);
            button(to, kPad + half + kFootGap, kFootY, half, kRowH, "Thoát", DRV_LCD_INK,
                   held_ == 2);
            return;
        }
        if (!refusing()) {
            const int step = gauge(seen);
            meter(to, step, step >= kGaugeSteps ? DRV_LCD_ACCENT : DRV_LCD_WARN);
            const char *line = hint(seen);
            if (line == nullptr) {
                line = armed_ ? "Giữ nguyên" : nullptr;
            }
            if (line != nullptr) {
                to.text_centred(kHintY, line, DRV_LCD_INK);
            }
        }
        button(to, kPad, kFootY, APP_LCD_H_RES - 2 * kPad, kRowH, "Huỷ", DRV_LCD_INK, held_ == 1);
    }

private:
    static constexpr int kFootY = APP_LCD_V_RES - kRowH - kPad;
    const char *why_ = nullptr;
    static constexpr const char *kAsk[kSamples] = { "Nhìn thẳng vào camera",
                                                    "Quay nhẹ sang trái",
                                                    "Quay nhẹ sang phải" };

    static void meter(Canvas &to, int step, uint8_t tone) noexcept
    {
        const int width = 200;
        const int x = (APP_LCD_H_RES - width) / 2;
        to.rounded(x, kGaugeY, width, 10, 5, 2, DRV_LCD_INK);
        const int lit = (width - 6) * step / kGaugeSteps;
        if (lit > 0) {
            to.fill(x + 3, kGaugeY + 3, lit, 4, tone);
        }
    }

    float wanted() const noexcept { return kept_ == 1 ? kTurnSign : -kTurnSign; }

    // yaw_of() reads zero at "nose between the eyes", which sits off the lens by
    // a different amount on every face and every mounting (KEHOACH 4.5.5h.2).
    float origin() const noexcept
    {
        return origin_n_ > 0 ? origin_sum_ / (float)origin_n_ : 0.0f;
    }

    void feed(const Sight &seen) noexcept
    {
        if (seen.samples == sampled_) {
            return;
        }
        sampled_ = seen.samples;
        if (!seen.face) {
            voted_ = 0;
            return;
        }
        votes_[ring_] = seen.yaw;
        ring_ = (ring_ + 1) % kYawVotes;
        voted_ = voted_ < kYawVotes ? voted_ + 1 : voted_;
        yaw_ = voted_ < kYawVotes ? seen.yaw : median_of(votes_);
        // The frontal sample is the one stretch known to face the lens.
        if (kept_ == 0 && yaw_ > -kTurnYaw && yaw_ < kTurnYaw) {
            origin_sum_ += yaw_;
            ++origin_n_;
        }
    }

    // Six seconds of trying settles for the best turn this person managed rather
    // than keeping them at the screen (KEHOACH 4.5.5h.2).
    float reach() const noexcept
    {
        if (wait_ms_ < kPoseWaitMs) {
            return kTurnYaw;
        }
        return best_ > kTurnYaw ? kTurnYaw : best_ * 0.8f;
    }

    bool posed(const Sight &seen) const noexcept
    {
        if (!seen.face) {
            return false;
        }
        if (kept_ == 0) {
            return yaw_ > -kFrontalYaw && yaw_ < kFrontalYaw;
        }
        return (yaw_ - origin()) * wanted() >= reach();
    }

    void watch(const Sight &seen) noexcept
    {
        if (!seen.face || kept_ == 0) {
            return;
        }
        const float turn = (yaw_ - origin()) * wanted();
        best_ = turn > best_ ? turn : best_;
    }

    // Full means accepted, not perfect: facing the lens measures within 0.05 of
    // zero, so a bar scaled off zero would sit at half while already good.
    int gauge(const Sight &seen) const noexcept
    {
        if (!seen.face) {
            return 0;
        }
        if (posed(seen)) {
            return kGaugeSteps;
        }
        const float off = yaw_ < 0.0f ? -yaw_ : yaw_;
        float part = kept_ == 0 ? kFrontalYaw / (off > 0.0f ? off : kFrontalYaw)
                                : (yaw_ - origin()) * wanted() / reach();
        part = part < 0.0f ? 0.0f : (part > 1.0f ? 1.0f : part);
        return (int)(part * (float)(kGaugeSteps - 1));
    }

    // A face too close or off centre never reaches the template stage at all, so
    // the framing line outranks the pose line (KEHOACH 4.5.5h.2).
    const char *hint(const Sight &seen) const noexcept
    {
        if (!seen.face || seen.stage != UI_KIOSK_STAGE_WORKING) {
            return prompt_for(seen.stage);
        }
        if (kept_ == 0) {
            return nullptr;
        }
        return wrong_ ? "Quay ngược lại" : nullptr;
    }

    // Any turn against the asked side counts, not only a wide one: silence is
    // when a person decides the machine is broken (KEHOACH 4.5.5h.2 rule 4).
    bool astray(const Sight &seen) const noexcept
    {
        if (!seen.face || kept_ == 0) {
            return false;
        }
        const float turn = (yaw_ - origin()) * wanted();
        return wrong_ ? turn < 0.0f : turn < -kWrongYaw;
    }

    // Retry keeps the id and the name, so the three fresh samples overwrite the
    // three old ones by (employee_id, template_idx) (KEHOACH 4.5.5h.2).
    void restart() noexcept
    {
        kept_ = 0;
        origin_sum_ = 0.0f;
        origin_n_ = 0;
        voted_ = 0;
        ring_ = 0;
        yaw_ = 0.0f;
        took_ = false;
        failed_ = false;
        why_ = nullptr;
        refused_ms_ = kRefusalShowMs;
        begin();
    }

    void begin() noexcept
    {
        // The pipeline counts its tries per sample, and a screen counting any
        // other way either gives up early or waits out a dead budget.
        spoofs_ = 0;
        since_ms_ = 0;
        wait_ms_ = 0;
        pose_ms_ = 0;
        best_ = 0.0f;
        armed_ = false;
        wrong_ = false;
        step_ = -1;
    }

    void arm() noexcept
    {
        const float mid = origin();
        float low = mid - kFrontalYaw;
        float high = mid + kFrontalYaw;
        if (kept_ > 0) {
            // The screen has settled the pose; the pipeline only has to catch a
            // face that came back to frontal (KEHOACH 4.5.5h.2).
            const float edge = reach() < kFrontalYaw ? reach() : kFrontalYaw;
            low = wanted() > 0.0f ? mid + edge : -kOpenYaw;
            high = wanted() > 0.0f ? kOpenYaw : mid - edge;
        }
        enrol_request().employee_id = kNewPerson;
        enrol_request().template_idx = (uint16_t)kept_;
        enrol_request().yaw_min = low;
        enrol_request().yaw_max = high;
        enrol_request().waiting = true;
        armed_ = true;
    }

    int kept_ = 0;
    int spoofs_ = 0;
    int64_t refused_ms_ = 0;
    int64_t since_ms_ = 0;
    int64_t wait_ms_ = 0;
    int64_t pose_ms_ = 0;
    float best_ = 0.0f;
    float origin_sum_ = 0.0f;           // frontal readings, summed for a mean
    int origin_n_ = 0;
    uint32_t sampled_ = 0;              // last Sight::samples folded in
    float votes_[kYawVotes] = {};
    int ring_ = 0;
    int voted_ = 0;
    float yaw_ = 0.0f;                  // the de-spiked turn every gate reads
    int step_ = -1;
    bool took_ = false;
    bool armed_ = false;
    bool wrong_ = false;
    bool failed_ = false;
    int held_ = 0;                        // 0 none, 1 left button, 2 right
};

class ListScreen final : public Screen {
public:
    bool opaque() const noexcept override { return true; }

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
class PeopleScreen final : public Screen {
public:
    bool opaque() const noexcept override { return true; }

    void on_enter() noexcept override
    {
        people().wanted = true;
        held_ = kNothing;
        armed_ = kNothing;
        going_ = 0;
    }

    void delivered() noexcept { going_ = 0; }

    bool on_touch(int x, int y, bool down) noexcept override
    {
        const int hit = row_at(x, y);
        if (down) {
            held_ = hit;
            return true;
        }
        const int fire = held_ == hit ? hit : kNothing;
        held_ = kNothing;
        if (fire == kBack) {
            manager().go(ScreenId::Menu);
            return true;
        }
        if (fire < 0 || fire >= people().count) {
            armed_ = kNothing;
            return true;
        }
        // The second touch on the same row is the confirmation (KEHOACH 4.5.5h.3).
        if (fire == armed_) {
            going_ = people().row[fire].employee_id;
            remove_request().employee_id = going_;
            remove_request().waiting = true;
            armed_ = kNothing;
            return true;
        }
        armed_ = fire;
        return true;
    }

    void paint(Canvas &to, const Sight &seen) noexcept override
    {
        (void)seen;
        top_bar(to, nullptr);
        to.text_centred(kBarH + 12, "Danh sách", DRV_LCD_INK);
        if (people().count == 0) {
            to.text_centred(kRowTop, "Chưa có ai", DRV_LCD_WARN);
        } else {
            to.text_centred(kBarH + 44, "Chạm hai lần vào một dòng để xoá", DRV_LCD_EDGE);
        }
        for (int i = 0; i < people().count; ++i) {
            const ui_kiosk_person_t &who = people().row[i];
            const int y = kRowTop + i * kRowStep;
            const bool leaving = going_ != 0 && who.employee_id == going_;
            if (i == armed_ || leaving) {
                to.rounded(kPad - 6, y - 6, APP_LCD_H_RES - 2 * kPad + 12, kRowStep, kRadius,
                           kEdge, DRV_LCD_WARN);
            }
            char line[STORAGE_NAME_CAP + 24];
            snprintf(line, sizeof(line), "%s  ·  %u mẫu",
                     who.name[0] != '\0' ? who.name : "Chưa đặt tên", (unsigned)who.templates);
            to.text(kPad, y, line, DRV_LCD_INK);
            const char *tail = leaving ? "Đang xoá…" : (i == armed_ ? "Xoá?" : nullptr);
            if (tail != nullptr) {
                to.text(APP_LCD_H_RES - kPad - Canvas::text_width(tail), y, tail, DRV_LCD_WARN);
            }
        }
        button(to, kPad, kFootY, APP_LCD_H_RES - 2 * kPad, kRowH, "Quay lại", DRV_LCD_INK,
               held_ == kBack);
    }

private:
    static constexpr int kNothing = -1;
    static constexpr int kBack = -2;
    static constexpr int kFootY = APP_LCD_V_RES - kRowH - kPad;
    static constexpr int kRowTop = kBarH + 76;
    static constexpr int kRowStep = 36;

    int row_at(int x, int y) const noexcept
    {
        if (inside(x, y, kPad, kFootY, APP_LCD_H_RES - 2 * kPad, kRowH)) {
            return kBack;
        }
        for (int i = 0; i < people().count; ++i) {
            if (inside(x, y, kPad - 6, kRowTop + i * kRowStep - 6, APP_LCD_H_RES - 2 * kPad + 12,
                       kRowStep)) {
                return i;
            }
        }
        return kNothing;
    }

    int held_ = kNothing;
    int armed_ = kNothing;
    uint32_t going_ = 0;
};


class WifiScreen final : public Screen {
public:
    bool opaque() const noexcept override { return true; }

    void on_enter() noexcept override
    {
        step_ = Step::Looking;
        networks().wanted = true;
        networks().fresh = false;
        typed_[0] = '\0';
        chosen_ = kNothing;
        held_ = kNothing;
        set_ = 0;
    }

    bool tick(uint32_t dt_ms, const Sight &seen) noexcept override
    {
        (void)dt_ms;
        (void)seen;
        if (step_ == Step::Looking && networks().fresh) {
            step_ = Step::Choosing;
            return true;
        }
        if (step_ == Step::Joining && join_request().answered) {
            join_request().answered = false;
            step_ = join_request().result == ESP_OK ? Step::Joined : Step::Refused;
            return true;
        }
        return false;
    }

    bool on_touch(int x, int y, bool down) noexcept override
    {
        const int hit = step_ == Step::Typing ? key_at(x, y) : row_at(x, y);
        if (down) {
            held_ = hit;
            return true;
        }
        const int fire = held_ == hit ? hit : kNothing;
        held_ = kNothing;
        if (fire == kNothing) {
            return true;
        }
        if (fire == kBack) {
            manager().go(ScreenId::Menu);
            return true;
        }
        return step_ == Step::Typing ? typing(fire) : choosing(fire);
    }

    void paint(Canvas &to, const Sight &seen) noexcept override
    {
        (void)seen;
        top_bar(to, nullptr);
        to.text_centred(kBarH + 12, "Wi-Fi", DRV_LCD_INK);
        switch (step_) {
        case Step::Looking: to.text_centred(kRowTop, "Đang quét…", DRV_LCD_EDGE); break;
        case Step::Choosing: paint_list(to); break;
        case Step::Typing: paint_keys(to); break;
        case Step::Joining: to.text_centred(kRowTop, "Đang kết nối…", DRV_LCD_EDGE); break;
        case Step::Joined: to.text_centred(kRowTop, "Đã kết nối", DRV_LCD_ACCENT); break;
        case Step::Refused: to.text_centred(kRowTop, "Không vào được", DRV_LCD_WARN); break;
        }
        if (step_ != Step::Typing) {
            button(to, kPad, kFootY, APP_LCD_H_RES - 2 * kPad, kRowH, "Quay lại", DRV_LCD_INK,
                   held_ == kBack);
        }
    }

private:
    enum class Step : uint8_t { Looking, Choosing, Typing, Joining, Joined, Refused };

    static constexpr int kNothing = -1;
    static constexpr int kBack = -2;
    static constexpr int kRescan = -3;
    static constexpr int kFootY = APP_LCD_V_RES - kRowH - kPad;
    static constexpr int kRowTop = kBarH + 60;
    static constexpr int kRowStep = 36;
    static constexpr int kCols = 7;
    static constexpr int kKeys = 28;
    static constexpr int kKeyW = 40;
    static constexpr int kKeyH = 40;
    static constexpr int kKeyGap = 4;
    static constexpr int kKeyTop = 150;
    static constexpr int kDel = 100;
    static constexpr int kShift = 101;
    static constexpr int kCancel = 102;
    static constexpr int kJoin = 103;
    // Three sets of exactly kKeys, because a passphrase is not a name.
    static constexpr const char *kSets[3] = { "abcdefghijklmnopqrstuvwxyz@.",
                                              "ABCDEFGHIJKLMNOPQRSTUVWXYZ-_",
                                              "0123456789!@#$%^&*()-_+=.,?/" };

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
        const int half = (APP_LCD_H_RES - 2 * kPad - kFootGap) / 2;
        if (inside(x, y, kPad, kFootY - kRowH - 8, half, kRowH)) { return kDel; }
        if (inside(x, y, kPad + half + kFootGap, kFootY - kRowH - 8, half, kRowH)) { return kShift; }
        if (inside(x, y, kPad, kFootY, half, kRowH)) { return kCancel; }
        if (inside(x, y, kPad + half + kFootGap, kFootY, half, kRowH)) { return kJoin; }
        return kNothing;
    }

    int row_at(int x, int y) const noexcept
    {
        if (inside(x, y, kPad, kFootY, APP_LCD_H_RES - 2 * kPad, kRowH)) {
            return kBack;
        }
        if (step_ != Step::Choosing) {
            return kNothing;
        }
        for (int i = 0; i < networks().count; ++i) {
            if (inside(x, y, kPad - 6, kRowTop + i * kRowStep - 6, APP_LCD_H_RES - 2 * kPad + 12,
                       kRowStep)) {
                return i;
            }
        }
        const int at = kRowTop + networks().count * kRowStep;
        return inside(x, y, kPad, at, APP_LCD_H_RES - 2 * kPad, kRowH) ? kRescan : kNothing;
    }

    bool choosing(int fire) noexcept
    {
        if (fire == kRescan) {
            step_ = Step::Looking;
            networks().fresh = false;
            networks().wanted = true;
            return true;
        }
        if (fire < 0 || fire >= networks().count) {
            return true;
        }
        chosen_ = fire;
        typed_[0] = '\0';
        if (networks().row[fire].open) {
            ask_join();
            return true;
        }
        step_ = Step::Typing;
        set_ = 0;
        return true;
    }

    bool typing(int fire) noexcept
    {
        const size_t at = strlen(typed_);
        if (fire == kDel) {
            if (at > 0) { typed_[at - 1] = '\0'; }
            return true;
        }
        if (fire == kShift) {
            set_ = (set_ + 1) % 3;
            return true;
        }
        if (fire == kCancel) {
            step_ = Step::Choosing;
            return true;
        }
        if (fire == kJoin) {
            ask_join();
            return true;
        }
        if (fire >= 0 && fire < kKeys && at + 1 < sizeof(typed_)) {
            typed_[at] = kSets[set_][fire];
            typed_[at + 1] = '\0';
        }
        return true;
    }

    void ask_join() noexcept
    {
        strlcpy(join_request().ssid, networks().row[chosen_].ssid, sizeof(join_request().ssid));
        strlcpy(join_request().pass, typed_, sizeof(join_request().pass));
        join_request().answered = false;
        join_request().waiting = true;
        step_ = Step::Joining;
    }

    void paint_list(Canvas &to) noexcept
    {
        if (networks().count == 0) {
            to.text_centred(kRowTop, "Không thấy mạng nào", DRV_LCD_WARN);
        }
        for (int i = 0; i < networks().count; ++i) {
            const ui_kiosk_ap_t &ap = networks().row[i];
            const int y = kRowTop + i * kRowStep;
            if (i == held_) {
                to.rounded(kPad - 6, y - 6, APP_LCD_H_RES - 2 * kPad + 12, kRowStep, kRadius,
                           kEdge, DRV_LCD_ACCENT);
            }
            to.text(kPad, y, ap.ssid, DRV_LCD_INK);
            char tail[16];
            snprintf(tail, sizeof(tail), "%d%s", ap.rssi_dbm, ap.open ? "" : " ·");
            to.text(APP_LCD_H_RES - kPad - Canvas::text_width(tail), y, tail, DRV_LCD_EDGE);
        }
        button(to, kPad, kRowTop + networks().count * kRowStep, APP_LCD_H_RES - 2 * kPad, kRowH,
               "Quét lại", DRV_LCD_INK, held_ == kRescan);
    }

    void paint_keys(Canvas &to) noexcept
    {
        to.text(kPad, kBarH + 40, networks().row[chosen_].ssid, DRV_LCD_EDGE);
        to.rounded(kPad, kBarH + 72, APP_LCD_H_RES - 2 * kPad, 44, kRadius, kEdge, DRV_LCD_ACCENT);
        to.text(kPad + 12, kBarH + 72 + (44 - Canvas::line_height()) / 2,
                typed_[0] != '\0' ? typed_ : "…", DRV_LCD_INK);
        for (int i = 0; i < kKeys; ++i) {
            char label[8] = { 0 };
            snprintf(label, sizeof(label), "%c", kSets[set_][i]);
            button(to, key_x(i), key_y(i), kKeyW, kKeyH, label, DRV_LCD_INK, held_ == i);
        }
        const int half = (APP_LCD_H_RES - 2 * kPad - kFootGap) / 2;
        button(to, kPad, kFootY - kRowH - 8, half, kRowH, "Xoá", DRV_LCD_INK, held_ == kDel);
        button(to, kPad + half + kFootGap, kFootY - kRowH - 8, half, kRowH,
               set_ == 2 ? "abc" : (set_ == 0 ? "ABC" : "123"), DRV_LCD_INK, held_ == kShift);
        button(to, kPad, kFootY, half, kRowH, "Huỷ", DRV_LCD_INK, held_ == kCancel);
        button(to, kPad + half + kFootGap, kFootY, half, kRowH, "Kết nối", DRV_LCD_ACCENT,
               held_ == kJoin);
    }

    Step step_ = Step::Looking;
    int held_ = kNothing;
    int chosen_ = kNothing;
    int set_ = 0;
    char typed_[UI_KIOSK_WIFI_PASS_CAP] = {};
};

PeopleScreen s_people;
WifiScreen s_wifi;
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

Networks &networks() noexcept
{
    return s_networks;
}

JoinRequest &join_request() noexcept
{
    return s_join;
}

EnrolRequest &enrol_request() noexcept
{
    return s_request;
}

RemoveRequest &remove_request() noexcept
{
    return s_remove;
}

void people_delivered() noexcept
{
    s_people.delivered();
}

void enrol_kept() noexcept
{
    s_capture.kept_one();
}

void enrol_refused() noexcept
{
    s_capture.refused_one();
}

bool enrol_complete() noexcept
{
    return s_capture.done();
}

void settings_line(int at, const char *text) noexcept
{
    s_settings.say(at, text);
}

People &people() noexcept
{
    return s_people_list;
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

Screen *wifi_screen() noexcept
{
    return &s_wifi;
}

Screen *settings_screen() noexcept
{
    return &s_settings;
}

}  // namespace ui
