#include "screens.hpp"

#include <stdio.h>
#include <string.h>
#include <time.h>

#include "strings.hpp"
#include "widgets.hpp"

namespace ui {

namespace {

using theme::Font;
using theme::Stack;

constexpr int kHeadH = 44;
constexpr int kContentY = theme::kBarH + kHeadH + theme::kGapL;
constexpr int kRowH = 58;
constexpr int kFactH = 42;
constexpr int kFootY = APP_LCD_V_RES - theme::kButtonH - theme::kGutter;
constexpr int kListEnd = APP_LCD_V_RES - theme::kGutter;
constexpr int kWideX = theme::kGapS;
constexpr int kWideW = APP_LCD_H_RES - 2 * theme::kGapS;

// However long a list grows, only the rows that clear the panel get drawn.
int list_fits(int count, int row_h, int bottom)
{
    const int room = (bottom - kContentY) / row_h;
    return count < room ? count : (room > 0 ? room : 0);
}
constexpr int kGuideW = 240;
constexpr int kGuideH = 296;
constexpr int kGuideX = (APP_LCD_H_RES - kGuideW) / 2;
constexpr int kGuideY = 96;
constexpr int kPromptY = kGuideY + kGuideH + 18;
constexpr int kBandH = 96;
constexpr int kBandY = APP_LCD_V_RES - kBandH - theme::kGutter;
constexpr int kMenuBox = 44;
constexpr int kRingR = 26;
constexpr int kKeyRadius = 8;

constexpr int kSamples = 3;
constexpr int64_t kSampleGapMs = 400;
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
constexpr int64_t kRescanMs = 15000;
// A stranger needs 2.9 s to be refused at worst (KEHOACH 4.5.5d), so past
// double that the pipeline owes an answer it is not going to give.
constexpr int64_t kWorkingCeilingMs = 6000;

// A phone keyboard, because the operator's thumbs already know where the
// letters are: ten, nine, then seven under a shift and a backspace.
constexpr int kKeys = 26;
constexpr int kKeyW = 26;
constexpr int kKeyH = 42;
constexpr int kKeyGap = 5;
constexpr int kKeyVGap = 6;
constexpr int kKeyRows = 4;
constexpr int kWideKey = 44;
constexpr int kLayerKey = 48;
constexpr int kEnterKey = 72;
constexpr int kKeyTop = APP_LCD_V_RES - theme::kGapM - kKeyRows * kKeyH - 3 * kKeyVGap;
constexpr int kFieldH = 48;
constexpr int kFieldY = kKeyTop - theme::kGapL - kFieldH;
constexpr int kFieldHintY = kFieldY - theme::kGapS - 21;

constexpr int kShift = 100;
constexpr int kDel = 101;
constexpr int kLayer = 102;
constexpr int kSpace = 103;
constexpr int kOk = 104;

constexpr const char *kLayers[3] = { "qwertyuiopasdfghjklzxcvbnm",
                                     "QWERTYUIOPASDFGHJKLZXCVBNM",
                                     "1234567890@#$_&-+()*\"\':;!?" };

int key_row(int i)
{
    return i < 10 ? 0 : (i < 19 ? 1 : 2);
}

int key_y(int i)
{
    return kKeyTop + key_row(i) * (kKeyH + kKeyVGap);
}

int key_x(int i)
{
    const int row = key_row(i);
    if (row == 0) {
        return (APP_LCD_H_RES - (10 * kKeyW + 9 * kKeyGap)) / 2 + i * (kKeyW + kKeyGap);
    }
    if (row == 1) {
        return (APP_LCD_H_RES - (9 * kKeyW + 8 * kKeyGap)) / 2 + (i - 10) * (kKeyW + kKeyGap);
    }
    const int span = kWideKey + kKeyGap + 7 * kKeyW + 6 * kKeyGap + kKeyGap + kWideKey;
    const int left = (APP_LCD_H_RES - span) / 2;
    return left + kWideKey + kKeyGap + (i - 19) * (kKeyW + kKeyGap);
}

bool above_keys(int y)
{
    return y < kFieldY;
}

int bottom_row_y()
{
    return kKeyTop + 3 * (kKeyH + kKeyVGap);
}

int shift_x()
{
    const int span = kWideKey + kKeyGap + 7 * kKeyW + 6 * kKeyGap + kKeyGap + kWideKey;
    return (APP_LCD_H_RES - span) / 2;
}

int del_x()
{
    return shift_x() + kWideKey + kKeyGap + 7 * kKeyW + 7 * kKeyGap;
}

int space_x()
{
    return shift_x() + kLayerKey + kKeyGap;
}

int space_w()
{
    const int span = kWideKey + kKeyGap + 7 * kKeyW + 6 * kKeyGap + kKeyGap + kWideKey;
    return span - kLayerKey - kEnterKey - 2 * kKeyGap;
}

int enter_x()
{
    return space_x() + space_w() + kKeyGap;
}

constexpr int kNothing = -1;
constexpr int kBack = -2;

ScreenManager s_manager;
EnrolRequest s_request;
RemoveRequest s_remove;
People s_people_list;
Pending s_pending;
Networks s_networks;
JoinRequest s_join;
Facts s_facts;
ui_kiosk_net_t s_net;
Ticket s_ticket;
Level s_brightness = { 70, false, false };
Restart s_vision_reset = Restart::No;
Level s_volume = { 60, false, false };
bool s_language_changed = false;

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

// Bands, not decibels: the reader already knows this shape from a phone.
int signal_level(int rssi_dbm)
{
    if (rssi_dbm >= -55) {
        return 4;
    }
    if (rssi_dbm >= -67) {
        return 3;
    }
    return rssi_dbm >= -78 ? 2 : 1;
}

void status_bar(Canvas &to, bool on_video)
{
    const uint8_t ink = DRV_LCD_INK;
    const uint8_t rest = on_video ? DRV_LCD_EDGE : DRV_LCD_LINE;
    char now[8] = { 0 };
    clock_text(now, sizeof(now));
    const int y = Canvas::centre_y(Font::Caption, 0, theme::kBarH);
    if (on_video) {
        to.text_on_video(Font::Caption, theme::kGutter, y, 80, now, ink);
    } else {
        to.text(Font::Caption, theme::kGutter, y, 80, now, ink);
    }
    const int box = 22;
    widgets::wifi_bars(to, APP_LCD_H_RES - theme::kGutter - box, (theme::kBarH - box) / 2, box,
                       s_net.joined ? signal_level(s_net.rssi_dbm) : 0, ink, rest);
}

void page(Canvas &to, const char *title, bool back)
{
    to.fill(0, 0, APP_LCD_H_RES, APP_LCD_V_RES, DRV_LCD_GROUND);
    status_bar(to, false);
    widgets::header(to, title, back);
}

// Corners, not an outline: a thirtieth of the cells, and the shape every
// camera app uses for "put it here" (KEHOACH 4.5.5h).
void guide(Canvas &to, uint8_t tone)
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
            return text(StrId::ScanTooFar);
        case UI_KIOSK_STAGE_TOO_CLOSE:
            return text(StrId::ScanTooClose);
        case UI_KIOSK_STAGE_OFF_GUIDE:
            return text(StrId::ScanFrame);
        case UI_KIOSK_STAGE_WORKING:
            return text(StrId::ScanWorking);
        case UI_KIOSK_STAGE_SETTLED:
            return nullptr;
        default:
            return text(StrId::ScanFrame);
    }
}

const char *refusal(app_ui_verdict_t verdict)
{
    switch (verdict) {
        case APP_UI_SPOOF:
            return text(StrId::ScanSpoof);
        case APP_UI_UNKNOWN:
            return text(StrId::ScanUnknown);
        case APP_UI_DENIED:
            return text(StrId::ScanDenied);
        default:
            return nullptr;
    }
}

const char *fact_label(ui_kiosk_fact_kind_t kind)
{
    switch (kind) {
        case UI_KIOSK_FACT_DEVICE_ID:
            return text(StrId::DeviceId);
        case UI_KIOSK_FACT_ENROLLED:
            return text(StrId::DeviceEnrolled);
        case UI_KIOSK_FACT_RECORDS:
            return text(StrId::DeviceRecords);
        case UI_KIOSK_FACT_WIFI_DROPS:
            return text(StrId::DeviceWifiDrops);
        case UI_KIOSK_FACT_WAKE_WITHIN:
            return text(StrId::DeviceWakeWithin);
        case UI_KIOSK_FACT_MIN_FACE:
            return text(StrId::DeviceMinFace);
        case UI_KIOSK_FACT_RAM_FREE:
            return text(StrId::DeviceRamFree);
        default:
            return text(StrId::DeviceVersion);
    }
}

void keyboard(Canvas &to, int layer, int held, const char *enter)
{
    const char *set = kLayers[layer];
    for (int i = 0; i < kKeys; ++i) {
        char label[8] = { 0 };
        snprintf(label, sizeof(label), "%c", set[i]);
        widgets::key_cap(to, key_x(i), key_y(i), kKeyW, kKeyH, label, widgets::Icon::None,
                         held == i, false);
    }
    const int row3 = kKeyTop + 2 * (kKeyH + kKeyVGap);
    widgets::key_cap(to, shift_x(), row3, kWideKey, kKeyH, layer == 1 ? "abc" : "ABC",
                     widgets::Icon::None, held == kShift, true);
    widgets::key_cap(to, del_x(), row3, kWideKey, kKeyH, "", widgets::Icon::Backspace,
                     held == kDel, true);
    const int row4 = bottom_row_y();
    widgets::key_cap(to, shift_x(), row4, kLayerKey, kKeyH, layer == 2 ? "abc" : "?123",
                     widgets::Icon::None, held == kLayer, true);
    widgets::key_cap(to, space_x(), row4, space_w(), kKeyH, "", widgets::Icon::None,
                     held == kSpace, false);
    to.card(enter_x(), row4, kEnterKey, kKeyH, kKeyRadius,
            held == kOk ? DRV_LCD_SURFACE_HI : DRV_LCD_ACCENT);
    to.text(Font::Body, enter_x(), Canvas::centre_y(Font::Body, row4, kKeyH), kEnterKey, enter,
            DRV_LCD_INK, Align::Centre);
}

int key_hit(int x, int y)
{
    for (int i = 0; i < kKeys; ++i) {
        if (inside(x, y, key_x(i), key_y(i), kKeyW, kKeyH)) {
            return i;
        }
    }
    const int row3 = kKeyTop + 2 * (kKeyH + kKeyVGap);
    if (inside(x, y, shift_x(), row3, kWideKey, kKeyH)) {
        return kShift;
    }
    if (inside(x, y, del_x(), row3, kWideKey, kKeyH)) {
        return kDel;
    }
    const int row4 = bottom_row_y();
    if (inside(x, y, shift_x(), row4, kLayerKey, kKeyH)) {
        return kLayer;
    }
    if (inside(x, y, space_x(), row4, space_w(), kKeyH)) {
        return kSpace;
    }
    if (inside(x, y, enter_x(), row4, kEnterKey, kKeyH)) {
        return kOk;
    }
    return kNothing;
}

void field(Canvas &to, const char *text, const char *hint)
{
    to.card(theme::kGutter, kFieldY, theme::kContentW, kFieldH, theme::kRadiusS, DRV_LCD_SURFACE);
    const bool empty = text[0] == '\0';
    to.text(Font::Body, theme::kGutter + theme::kGapM, Canvas::centre_y(Font::Body, kFieldY, kFieldH),
            theme::kContentW - 2 * theme::kGapM, empty ? hint : text,
            empty ? DRV_LCD_DIM : DRV_LCD_INK);
}

// A line about the kiosk itself, not the face, in the gap above the guide (KEHOACH 4.5.5h.1).
void ticket_line(Canvas &to)
{
    char line[64] = { 0 };
    switch (s_ticket.state) {
    case UI_KIOSK_TICKET_WAITING:
        snprintf(line, sizeof(line), text(StrId::TicketWaitingFmt), s_ticket.device_id);
        break;
    case UI_KIOSK_TICKET_REFUSED: strlcpy(line, text(StrId::TicketRefused), sizeof(line)); break;
    case UI_KIOSK_TICKET_NO_TOKEN: strlcpy(line, text(StrId::TicketNoToken), sizeof(line)); break;
    default: return;
    }
    to.text_on_video(Font::Caption, kWideX,
                     Canvas::centre_y(Font::Caption, theme::kBarH, kGuideY - theme::kBarH),
                     kWideW, line, DRV_LCD_WARN, Align::Centre);
}

class ScanScreen final : public Screen {
public:
    void on_enter() noexcept override
    {
        answered_ = false;
        carded_ = false;
        refused_ = nullptr;
        held_ = false;
        working_ms_ = 0;
        stuck_ = false;
        // The person standing here now gets a fresh look, not whatever the
        // pipeline settled on while a menu covered the preview.
        s_vision_reset = Restart::Returned;
    }

    bool tick(uint32_t dt_ms, const Sight &seen) noexcept override
    {
        const bool theirs = seen.face && seen.track == seen.verdict_track;
        const bool card = seen.verdict == APP_UI_GRANTED;
        // A card holds through a move; a refusal gives way to a new face (KEHOACH 4.5.5h.1).
        const bool up = seen.verdict > APP_UI_SCANNING && (card || theirs || !seen.face);
        const bool carded = up && card;
        const char *refused = up ? refusal(seen.verdict) : (theirs ? refused_ : nullptr);
        const bool answered = theirs || up;
        // Saying work is happening is a claim, and one that outlives every
        // verdict the pipeline could owe is a lie the glass keeps telling.
        const bool claiming = seen.face && seen.stage == UI_KIOSK_STAGE_WORKING && !answered;
        working_ms_ = claiming && seen.track == watched_ ? working_ms_ + (int64_t)dt_ms : 0;
        watched_ = seen.track;
        const bool stuck = working_ms_ >= kWorkingCeilingMs;
        if (stuck && !stuck_) {
            s_vision_reset = Restart::Stuck;
        }
        if (answered == answered_ && carded == carded_ && refused == refused_ &&
            stuck == stuck_) {
            return false;
        }
        answered_ = answered;
        carded_ = carded;
        refused_ = refused;
        stuck_ = stuck;
        return true;
    }

    bool on_touch(int x, int y, bool down) noexcept override
    {
        const bool on_menu = inside(x, y, APP_LCD_H_RES - kMenuBox, 0, kMenuBox, theme::kBarH);
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
        char now[8] = { 0 };
        clock_text(now, sizeof(now));
        to.text_on_video(Font::Caption, theme::kGutter,
                         Canvas::centre_y(Font::Caption, 0, theme::kBarH), 80, now, DRV_LCD_INK);
        const int box = 22;
        widgets::wifi_bars(to, APP_LCD_H_RES - kMenuBox - box - theme::kGapS,
                           (theme::kBarH - box) / 2, box,
                           s_net.joined ? signal_level(s_net.rssi_dbm) : 0, DRV_LCD_INK,
                           DRV_LCD_EDGE);
        widgets::icon(to, APP_LCD_H_RES - kMenuBox, 0, kMenuBox, widgets::Icon::Menu,
                      held_ ? DRV_LCD_ACCENT : DRV_LCD_INK);
        ticket_line(to);

        uint8_t tone = DRV_LCD_INK;
        const char *prompt = text(StrId::ScanFrame);
        if (refused_ != nullptr) {
            tone = DRV_LCD_WARN;
            prompt = nullptr;
        } else if (answered_) {
            tone = DRV_LCD_OK;
            prompt = nullptr;
        } else if (seen.stage == UI_KIOSK_STAGE_SETTLED) {
            // The kiosk has finished with this face: no guidance, no claim.
            tone = DRV_LCD_ACCENT;
            prompt = nullptr;
        } else if (seen.stage == UI_KIOSK_STAGE_WORKING && !stuck_) {
            tone = seen.face ? DRV_LCD_ACCENT : DRV_LCD_INK;
            prompt = seen.face ? prompt_for(seen.stage) : prompt;
        } else if (seen.stage != UI_KIOSK_STAGE_NO_FACE) {
            tone = DRV_LCD_WARN;
            prompt = prompt_for(seen.stage);
        }
        guide(to, tone);
        if (prompt != nullptr) {
            to.text_on_video(Font::Strong, kWideX, kPromptY, kWideW, prompt, DRV_LCD_INK,
                             Align::Centre);
        }

        if (refused_ != nullptr) {
            to.text_on_video(Font::Strong, kWideX, kBandY + kBandH / 2, kWideW, refused_,
                             DRV_LCD_WARN, Align::Centre);
            return;
        }
        // The card keeps its own clock; the latch above only silences guidance,
        // or a stamped face standing still would pin the card (KEHOACH 4.5.5h.1).
        if (carded_) {
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
            snprintf(who, sizeof(who), text(StrId::ScanCodeFmt), (unsigned)seen.employee_id);
        }
        to.card(theme::kGutter, kBandY, theme::kContentW, kBandH, theme::kRadius,
                DRV_LCD_SURFACE);
        const int cx = theme::kGutter + theme::kGapL + kRingR;
        const int cy = kBandY + kBandH / 2;
        to.disc(cx, cy, kRingR, DRV_LCD_OK);
        widgets::icon(to, cx - kRingR / 2, cy - kRingR / 2, kRingR, widgets::Icon::Check,
                      DRV_LCD_INK);
        const int text_x = cx + kRingR + theme::kGapM;
        const int room = theme::kGutter + theme::kContentW - theme::kGapM - text_x;
        const int block = theme::line_height(Font::Strong) + theme::line_height(Font::Caption) + 4;
        to.text(Font::Strong, text_x, cy - block / 2, room, who, DRV_LCD_INK);
        to.text(Font::Caption, text_x, cy - block / 2 + theme::line_height(Font::Strong) + 4, room,
                text(StrId::ScanCheckedIn), DRV_LCD_OK);
    }

    bool held_ = false;
    bool answered_ = false;
    bool carded_ = false;
    bool stuck_ = false;
    int64_t working_ms_ = 0;
    uint32_t watched_ = 0;                // track the working clock belongs to
    const char *refused_ = nullptr;
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
        const int fire = held_ == hit ? hit : kNothing;
        held_ = kNothing;
        switch (fire) {
            case 0: manager().go(ScreenId::Enrol); break;
            case 1: manager().go(ScreenId::People); break;
            case 2: manager().go(ScreenId::Settings); break;
            case kBack: manager().go(ScreenId::Scan); break;
            default: break;
        }
        return true;
    }

    void paint(Canvas &to, const Sight &seen) noexcept override
    {
        (void)seen;
        page(to, text(StrId::MenuTitle), false);
        widgets::card(to, theme::kGutter, kContentY, theme::kContentW, kRows * kRowH);
        for (int i = 0; i < kRows; ++i) {
            const int y = kContentY + i * kRowH;
            if (i > 0) {
                widgets::divider(to, theme::kGutter, y, theme::kContentW);
            }
            const widgets::Row what = { text(kLabels[i]), nullptr, kIcons[i], kTints[i],
                                        DRV_LCD_INK, -1,          widgets::Icon::None };
            widgets::row(to, theme::kGutter, y, theme::kContentW, kRowH, what, held_ == i);
        }
        widgets::button(to, theme::kGutter, kFootY, theme::kContentW, theme::kButtonH, text(StrId::MenuClose),
                        DRV_LCD_SURFACE, DRV_LCD_ACCENT, held_ == kBack);
    }

private:
    static constexpr int kRows = 3;
    static constexpr StrId kLabels[kRows] = { StrId::MenuEnrol, StrId::MenuPeople,
                                              StrId::MenuSettings };
    static constexpr widgets::Icon kIcons[kRows] = { widgets::Icon::PersonAdd,
                                                     widgets::Icon::List,
                                                     widgets::Icon::Sliders };
    static constexpr uint8_t kTints[kRows] = { DRV_LCD_ACCENT, DRV_LCD_OK, DRV_LCD_DIM };

    static int row_at(int x, int y) noexcept
    {
        if (inside(x, y, theme::kGutter, kFootY, theme::kContentW, theme::kButtonH)) {
            return kBack;
        }
        for (int i = 0; i < kRows; ++i) {
            if (inside(x, y, theme::kGutter, kContentY + i * kRowH, theme::kContentW, kRowH)) {
                return i;
            }
        }
        return kNothing;
    }

    int held_ = kNothing;
};

class SettingsScreen final : public Screen {
public:
    bool opaque() const noexcept override { return true; }

    void on_enter() noexcept override { held_ = kNothing; }

    bool on_touch(int x, int y, bool down) noexcept override
    {
        if (down && on_slider(x, y, kBright)) {
            drag(kBright, x);
            held_ = kBright;
            return true;
        }
        if (down && on_slider(x, y, kVolume)) {
            drag(kVolume, x);
            held_ = kVolume;
            return true;
        }
        if (down) {
            held_ = row_at(x, y);
            picked_ = held_ == kLanguage
                          ? widgets::segment_hit(x, theme::kGutter, theme::kContentW)
                          : kNothing;
            return true;
        }
        const int was = held_;
        held_ = kNothing;
        if (was == kBright || was == kVolume) {
            settle(was);
            return true;
        }
        if (was != row_at(x, y)) {
            return true;
        }
        switch (was) {
            case kLanguage: choose_language(x); break;
            case kDevice: manager().go(ScreenId::Device); break;
            case kWifi: manager().go(ScreenId::Wifi); break;
            case kBack: manager().go(ScreenId::Menu); break;
            default: break;
        }
        return true;
    }

    void paint(Canvas &to, const Sight &seen) noexcept override
    {
        (void)seen;
        page(to, text(StrId::MenuSettings), true);
        widgets::card(to, theme::kGutter, lang_y(), theme::kContentW, 2 * kRowH);
        widgets::segment_row(to, theme::kGutter, lang_y(), theme::kContentW, kRowH,
                             widgets::Icon::Globe, DRV_LCD_ACCENT, text(StrId::SettingsLanguage),
                             language_badge(Lang::Vi), language_badge(Lang::En),
                             language() == Lang::En, held_ == kLanguage);
        widgets::divider(to, theme::kGutter, device_y(), theme::kContentW);
        const widgets::Row me = { text(StrId::SettingsDevice), nullptr, widgets::Icon::Device,
                                  DRV_LCD_DIM,        DRV_LCD_INK, -1, widgets::Icon::None };
        widgets::row(to, theme::kGutter, device_y(), theme::kContentW, kRowH, me,
                     held_ == kDevice);

        widgets::card(to, theme::kGutter, wifi_y(), theme::kContentW, kRowH);
        const widgets::Row net = { "Wi-Fi",
                                   s_net.joined ? s_net.ssid : text(StrId::SettingsNotJoined),
                                   widgets::Icon::Wifi,
                                   DRV_LCD_ACCENT,
                                   DRV_LCD_INK,
                                   -1,
                                   widgets::Icon::None };
        widgets::row(to, theme::kGutter, wifi_y(), theme::kContentW, kRowH, net, held_ == kWifi);

        widgets::group_label(to, theme::kGutter, label_y(), theme::kContentW,
                             text(StrId::SettingsDisplay));
        widgets::card(to, theme::kGutter, slider_y(0), theme::kContentW, 2 * kRowH);
        widgets::slider_row(to, theme::kGutter, slider_y(0), theme::kContentW, kRowH,
                            widgets::Icon::Brightness, DRV_LCD_WARN, s_brightness.percent,
                            DRV_LCD_ACCENT);
        widgets::divider(to, theme::kGutter, slider_y(1), theme::kContentW);
        widgets::slider_row(to, theme::kGutter, slider_y(1), theme::kContentW, kRowH,
                            widgets::Icon::Volume, DRV_LCD_OK, s_volume.percent, DRV_LCD_ACCENT);
    }

private:
    static constexpr int kLanguage = 0;
    static constexpr int kDevice = 1;
    static constexpr int kWifi = 2;
    static constexpr int kBright = 3;
    static constexpr int kVolume = 4;

    static int lang_y() noexcept { return kContentY; }
    static int device_y() noexcept { return lang_y() + kRowH; }
    // Four rows and two sliders leave 25 px under the last card at kGapM, and
    // none at kGapL, so the cards sit a notch closer here than elsewhere.
    static int wifi_y() noexcept { return device_y() + kRowH + theme::kGapM; }
    static int label_y() noexcept { return wifi_y() + kRowH + theme::kGapM; }
    static int slider_y(int i) noexcept
    {
        return label_y() + theme::line_height(Font::Caption) + theme::kGapS + i * kRowH;
    }

    static bool on_slider(int x, int y, int which) noexcept
    {
        const int at = slider_y(which == kBright ? 0 : 1);
        return inside(x, y, theme::kGutter, at, theme::kContentW, kRowH);
    }

    static int row_at(int x, int y) noexcept
    {
        if (widgets::on_back(x, y)) {
            return kBack;
        }
        if (inside(x, y, theme::kGutter, lang_y(), theme::kContentW, kRowH)) {
            return kLanguage;
        }
        if (inside(x, y, theme::kGutter, device_y(), theme::kContentW, kRowH)) {
            return kDevice;
        }
        if (inside(x, y, theme::kGutter, wifi_y(), theme::kContentW, kRowH)) {
            return kWifi;
        }
        return kNothing;
    }

    // The finger has to land and lift on the same half, the way a button works.
    void choose_language(int x) noexcept
    {
        const int side = widgets::segment_hit(x, theme::kGutter, theme::kContentW);
        const Lang want = side == 1 ? Lang::En : Lang::Vi;
        if (side < 0 || side != picked_ || want == language()) {
            return;
        }
        set_language(want);
        language_changed() = true;
    }

    static void drag(int which, int x) noexcept
    {
        Level &level = which == kBright ? s_brightness : s_volume;
        level.percent = (uint8_t)widgets::slider_percent(x, theme::kGutter, theme::kContentW);
        level.changed = true;
        level.settled = false;
    }

    // The hardware hears every touch, NVS hears only the last (KEHOACH 4.5.5h.4).
    static void settle(int which) noexcept
    {
        Level &level = which == kBright ? s_brightness : s_volume;
        level.changed = true;
        level.settled = true;
    }

    int held_ = kNothing;
    int picked_ = kNothing;               // segment half the finger landed on
};

class DeviceScreen final : public Screen {
public:
    bool opaque() const noexcept override { return true; }

    bool on_touch(int x, int y, bool down) noexcept override
    {
        const bool hit = widgets::on_back(x, y);
        if (down) {
            held_ = hit;
            return true;
        }
        const bool fire = held_ && hit;
        held_ = false;
        if (fire) {
            manager().go(ScreenId::Settings);
        }
        return true;
    }

    void paint(Canvas &to, const Sight &seen) noexcept override
    {
        (void)seen;
        page(to, text(StrId::SettingsDevice), true);
        const int rows = list_fits(s_facts.count, kFactH, kListEnd);
        if (rows == 0) {
            to.text(Font::Body, theme::kGutter, kContentY, theme::kContentW, text(StrId::DeviceNoFacts),
                    DRV_LCD_DIM, Align::Centre);
        } else {
            widgets::card(to, theme::kGutter, kContentY, theme::kContentW, rows * kFactH);
        }
        Stack stack(kContentY);
        for (int i = 0; i < rows; ++i) {
            const int y = stack.take(kFactH, 0);
            if (i > 0) {
                widgets::divider(to, theme::kGutter, y, theme::kContentW);
            }
            const int pen = theme::kGutter + theme::kGapM;
            const int room = theme::kContentW - 2 * theme::kGapM;
            const char *name = fact_label(s_facts.row[i].kind);
            const int label_w = theme::text_width(Font::Body, name);
            const int given = room - label_w - theme::kGapM;
            to.text(Font::Body, pen, Canvas::centre_y(Font::Body, y, kFactH), label_w, name,
                    DRV_LCD_INK);
            to.text(Font::Caption, pen + room - given, Canvas::centre_y(Font::Caption, y, kFactH),
                    given, s_facts.row[i].value, DRV_LCD_DIM, Align::Right);
        }
    }

private:
    bool held_ = false;
};

class EnrolScreen final : public Screen {
public:
    bool opaque() const noexcept override { return true; }

    void on_enter() noexcept override
    {
        typing_ = false;
        layer_ = 1;
        typed_[0] = '\0';
        held_ = kNothing;
        s_pending.wanted = true;
    }

    bool on_touch(int x, int y, bool down) noexcept override
    {
        const int hit = widgets::on_back(x, y) || (typing_ && above_keys(y))
                            ? kBack
                            : (typing_ ? key_hit(x, y) : row_at(x, y));
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
            if (typing_) {
                typing_ = false;
            } else {
                manager().go(ScreenId::Menu);
            }
            return true;
        }
        return typing_ ? press(fire) : choose(fire);
    }

    void paint(Canvas &to, const Sight &seen) noexcept override
    {
        (void)seen;
        page(to, text(StrId::MenuEnrol), true);
        if (typing_) {
            paint_keys(to);
            return;
        }
        paint_list(to);
    }

private:
    static constexpr int kSelf = -3;

    // The fallback row is always the last one, so the list gives up its seat first.
    static int rows() noexcept { return list_fits(s_pending.count, kRowH, kListEnd - kRowH); }

    static int list_y(int i) noexcept { return kContentY + i * kRowH; }

    int row_at(int x, int y) const noexcept
    {
        if (widgets::on_back(x, y)) {
            return kBack;
        }
        for (int i = 0; i < rows(); ++i) {
            if (inside(x, y, theme::kGutter, list_y(i), theme::kContentW, kRowH)) {
                return i;
            }
        }
        return inside(x, y, theme::kGutter, self_y(), theme::kContentW, kRowH) ? kSelf : kNothing;
    }

    static int self_y() noexcept { return list_y(rows()); }

    bool choose(int fire) noexcept
    {
        if (fire == kBack) {
            manager().go(ScreenId::Menu);
            return true;
        }
        if (fire == kSelf) {
            typing_ = true;
            layer_ = 1;
            typed_[0] = '\0';
            return true;
        }
        if (fire < 0 || fire >= rows()) {
            return true;
        }
        enrol_request().employee_id = s_pending.row[fire].employee_id;
        strlcpy(enrol_request().name, s_pending.row[fire].name, sizeof(enrol_request().name));
        manager().go(ScreenId::Capture);
        return true;
    }

    bool press(int fire) noexcept
    {
        const size_t at = strlen(typed_);
        if (fire == kDel) {
            if (at > 0) {
                typed_[at - 1] = '\0';
            }
            return true;
        }
        if (fire == kShift) {
            layer_ = layer_ == 1 ? 0 : 1;
            return true;
        }
        if (fire == kLayer) {
            layer_ = layer_ == 2 ? 0 : 2;
            return true;
        }
        if (fire == kOk) {
            if (at == 0) {
                return true;
            }
            enrol_request().employee_id = kNewPerson;
            strlcpy(enrol_request().name, typed_, sizeof(enrol_request().name));
            manager().go(ScreenId::Capture);
            return true;
        }
        if (at + 1 >= sizeof(typed_)) {
            return true;
        }
        typed_[at] = fire == kSpace ? ' ' : kLayers[layer_][fire];
        typed_[at + 1] = '\0';
        return true;
    }

    void paint_list(Canvas &to) noexcept
    {
        const int count = rows();
        widgets::card(to, theme::kGutter, kContentY, theme::kContentW, (count + 1) * kRowH);
        if (count == 0) {
            to.text(Font::Caption, theme::kGutter, kContentY + (count + 1) * kRowH + theme::kGapM,
                    theme::kContentW, text(StrId::EnrolNobody), DRV_LCD_DIM, Align::Centre);
        }
        for (int i = 0; i < count; ++i) {
            const int y = list_y(i);
            if (i > 0) {
                widgets::divider(to, theme::kGutter, y, theme::kContentW);
            }
            char code[16];
            snprintf(code, sizeof(code), "%u", (unsigned)s_pending.row[i].employee_id);
            const widgets::Row what = { s_pending.row[i].name, code,
                                        widgets::Icon::PersonAdd, DRV_LCD_ACCENT,
                                        DRV_LCD_INK, -1, widgets::Icon::None };
            widgets::row(to, theme::kGutter, y, theme::kContentW, kRowH, what, held_ == i);
        }
        const int at = self_y();
        if (count > 0) {
            widgets::divider(to, theme::kGutter, at, theme::kContentW);
        }
        const widgets::Row self = { text(StrId::EnrolTypeName), nullptr, widgets::Icon::Keyboard,
                                    DRV_LCD_DIM,   DRV_LCD_INK, -1, widgets::Icon::None };
        widgets::row(to, theme::kGutter, at, theme::kContentW, kRowH, self, held_ == kSelf);
    }

    void paint_keys(Canvas &to) noexcept
    {
        to.text(Font::Caption, theme::kGutter, kFieldHintY, theme::kContentW,
                text(StrId::EnrolNameHint), DRV_LCD_DIM);
        field(to, typed_, text(StrId::EnrolNameEmpty));
        keyboard(to, layer_, held_, text(StrId::EnrolNext));
    }

    bool typing_ = false;
    int layer_ = 1;                       // a name opens on capitals
    char typed_[STORAGE_NAME_CAP] = { 0 };
    int held_ = kNothing;
};

class CaptureScreen final : public Screen {
public:
    void on_enter() noexcept override { restart(); }

    bool on_touch(int x, int y, bool down) noexcept override
    {
        const int wide = theme::kContentW;
        const int half = failed_ ? (wide - theme::kGapM) / 2 : wide;
        const bool on_left = inside(x, y, theme::kGutter, kFootY, half, theme::kButtonH);
        const bool on_right = failed_ && inside(x, y, theme::kGutter + half + theme::kGapM, kFootY,
                                                half, theme::kButtonH);
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
        const bool refusing_was = refusing();
        refused_ms_ += dt_ms;
        if (refusing_was != refusing()) {
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
        const int ask_y = theme::kBarH + theme::kGapS;
        uint8_t tone = DRV_LCD_INK;
        char line[64];
        // One line, one place. A correction and an instruction are the same kind
        // of sentence, and the guide leaves room for exactly one of them.
        if (failed_) {
            snprintf(line, sizeof(line), "%s", why_ != nullptr ? why_ : text(StrId::CaptureNoSample));
            tone = DRV_LCD_WARN;
        } else if (done()) {
            snprintf(line, sizeof(line), text(StrId::CaptureAddedFmt), enrol_request().name);
            tone = DRV_LCD_OK;
        } else if (refusing()) {
            snprintf(line, sizeof(line), text(StrId::CaptureSpoofFmt), spoofs_, kSpoofGiveUp);
            tone = DRV_LCD_WARN;
        } else {
            const char *fix = hint(seen);
            const char *say = fix != nullptr ? fix : (armed_ ? text(StrId::CaptureHold) : text(kAsk[kept_]));
            snprintf(line, sizeof(line), "%s", say);
            tone = fix != nullptr ? DRV_LCD_WARN : DRV_LCD_INK;
        }
        to.text_on_video(Font::Strong, kWideX, ask_y, kWideW, line, tone, Align::Centre);
        dots(to, ask_y + theme::line_height(Font::Strong) + 3);
        guide(to, done() ? DRV_LCD_OK : DRV_LCD_ACCENT);
        if (done()) {
            widgets::button(to, theme::kGutter, kFootY, theme::kContentW, theme::kButtonH,
                            text(StrId::CaptureConfirm), DRV_LCD_OK, DRV_LCD_INK, held_ == 1);
            return;
        }
        if (failed_) {
            const int half = (theme::kContentW - theme::kGapM) / 2;
            widgets::button(to, theme::kGutter, kFootY, half, theme::kButtonH, text(StrId::CaptureRetry),
                            DRV_LCD_ACCENT, DRV_LCD_INK, held_ == 1);
            widgets::button(to, theme::kGutter + half + theme::kGapM, kFootY, half,
                            theme::kButtonH, text(StrId::CaptureQuit), DRV_LCD_SURFACE, DRV_LCD_INK,
                            held_ == 2);
            return;
        }
        widgets::button(to, theme::kGutter, kFootY, theme::kContentW, theme::kButtonH, text(StrId::CaptureCancel),
                        DRV_LCD_SURFACE, DRV_LCD_INK, held_ == 1);
    }

private:
    const char *why_ = nullptr;
    static constexpr StrId kAsk[kSamples] = { StrId::CaptureLookAhead,
                                              StrId::CaptureTurnLeft,
                                              StrId::CaptureTurnRight };

    void dots(Canvas &to, int y) const noexcept
    {
        const int pill_w = 52;
        const int gap = 10;
        const int left = (APP_LCD_H_RES - (kSamples * pill_w + (kSamples - 1) * gap)) / 2;
        for (int i = 0; i < kSamples; ++i) {
            const int x = left + i * (pill_w + gap);
            const bool lit = i < kept_;
            const bool at = i == kept_ && !done();
            to.card(x, y, pill_w, 8, 4, lit ? DRV_LCD_OK : (at ? DRV_LCD_ACCENT : DRV_LCD_DIM));
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
        return wrong_ ? text(StrId::CaptureTurnBack) : nullptr;
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
        page(to, text(StrId::MenuPeople), true);
        const int count = shown();
        if (people().count == 0) {
            to.text(Font::Body, theme::kGutter, kContentY, theme::kContentW, text(StrId::PeopleEmpty),
                    DRV_LCD_DIM, Align::Centre);
        } else {
            widgets::card(to, theme::kGutter, kContentY, theme::kContentW, count * kRowH);
        }
        for (int i = 0; i < count; ++i) {
            const ui_kiosk_person_t &who = people().row[i];
            const int y = row_y(i);
            const bool leaving = going_ != 0 && who.employee_id == going_;
            if (i > 0) {
                widgets::divider(to, theme::kGutter, y, theme::kContentW);
            }
            char tail[24];
            if (leaving) {
                snprintf(tail, sizeof(tail), "%s", text(StrId::PeopleRemoving));
            } else if (i == armed_) {
                snprintf(tail, sizeof(tail), "%s", text(StrId::PeopleTapRemove));
            } else {
                snprintf(tail, sizeof(tail), text(StrId::PeopleTemplatesFmt), (unsigned)who.templates);
            }
            const bool hot = i == armed_ || leaving;
            const widgets::Row what = { who.name[0] != '\0' ? who.name : text(StrId::PeopleUnnamed),
                                        tail,
                                        widgets::Icon::Person,
                                        (uint8_t)(hot ? DRV_LCD_DANGER : DRV_LCD_ACCENT),
                                        (uint8_t)(hot ? DRV_LCD_DANGER : DRV_LCD_INK),
                                        -1,
                                        widgets::Icon::None };
            widgets::row(to, theme::kGutter, y, theme::kContentW, kRowH, what, held_ == i);
        }
    }

private:
    static int row_y(int i) noexcept { return kContentY + i * kRowH; }

    // Whatever the table holds, only rows that clear the footer get drawn.
    static int shown() noexcept { return list_fits(people().count, kRowH, kListEnd); }

    int row_at(int x, int y) const noexcept
    {
        if (widgets::on_back(x, y)) {
            return kBack;
        }
        for (int i = 0; i < shown(); ++i) {
            if (inside(x, y, theme::kGutter, row_y(i), theme::kContentW, kRowH)) {
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
        busy_ = kNothing;
        failed_ = kNothing;
        set_ = 0;
        idle_ms_ = 0;
    }

    bool tick(uint32_t dt_ms, const Sight &seen) noexcept override
    {
        (void)seen;
        if (step_ == Step::Looking && networks().fresh) {
            step_ = Step::Choosing;
            idle_ms_ = 0;
            return true;
        }
        if (busy_ != kNothing && join_request().answered) {
            join_request().answered = false;
            failed_ = join_request().result == ESP_OK ? kNothing : busy_;
            busy_ = kNothing;
            return true;
        }
        // A sweep takes the radio off its channel and flaps the broker link, so
        // only a kiosk still hunting for a network refreshes itself (KEHOACH 7.6).
        if (step_ != Step::Choosing || busy_ != kNothing || s_net.joined) {
            return false;
        }
        idle_ms_ += dt_ms;
        if (idle_ms_ < kRescanMs) {
            return false;
        }
        idle_ms_ = 0;
        networks().fresh = false;
        networks().wanted = true;
        return false;
    }

    bool on_touch(int x, int y, bool down) noexcept override
    {
        const int hit = widgets::on_back(x, y) || (step_ == Step::Typing && above_keys(y))
                            ? kBack
                            : (step_ == Step::Typing ? key_hit(x, y) : row_at(x, y));
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
            if (step_ == Step::Typing) {
                step_ = Step::Choosing;
                idle_ms_ = 0;
            } else {
                manager().go(ScreenId::Settings);
            }
            return true;
        }
        return step_ == Step::Typing ? typing(fire) : choosing(fire);
    }

    void paint(Canvas &to, const Sight &seen) noexcept override
    {
        (void)seen;
        page(to, "Wi-Fi", true);
        switch (step_) {
            case Step::Typing: paint_keys(to); break;
            case Step::Looking: note(to, text(StrId::WifiScanning), DRV_LCD_DIM); break;
            default: paint_list(to); break;
        }
    }

private:
    enum class Step : uint8_t { Looking, Choosing, Typing };

    static void note(Canvas &to, const char *line, uint8_t tone) noexcept
    {
        to.text(Font::Body, theme::kGutter, kContentY, theme::kContentW, line, tone,
                Align::Centre);
    }

    static int row_y(int i) noexcept { return kContentY + i * kRowH; }

    static int shown() noexcept { return list_fits(networks().count, kRowH, kListEnd); }

    int row_at(int x, int y) const noexcept
    {
        if (widgets::on_back(x, y)) {
            return kBack;
        }
        if (step_ != Step::Choosing) {
            return kNothing;
        }
        for (int i = 0; i < shown(); ++i) {
            if (inside(x, y, theme::kGutter, row_y(i), theme::kContentW, kRowH)) {
                return i;
            }
        }
        return kNothing;
    }

    bool choosing(int fire) noexcept
    {
        if (fire < 0 || fire >= networks().count || busy_ != kNothing) {
            return true;
        }
        chosen_ = fire;
        failed_ = kNothing;
        typed_[0] = '\0';
        // A network already in NVS joins on one touch, the way a phone does.
        if (networks().row[fire].open || networks().row[fire].saved) {
            ask_join(networks().row[fire].saved);
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
            if (at > 0) {
                typed_[at - 1] = '\0';
            }
            return true;
        }
        if (fire == kShift) {
            set_ = set_ == 1 ? 0 : 1;
            return true;
        }
        if (fire == kLayer) {
            set_ = set_ == 2 ? 0 : 2;
            return true;
        }
        if (fire == kOk) {
            ask_join(false);
            return true;
        }
        if (at + 1 >= sizeof(typed_)) {
            return true;
        }
        typed_[at] = fire == kSpace ? ' ' : kLayers[set_][fire];
        typed_[at + 1] = '\0';
        return true;
    }

    void ask_join(bool stored) noexcept
    {
        strlcpy(join_request().ssid, networks().row[chosen_].ssid, sizeof(join_request().ssid));
        strlcpy(join_request().pass, typed_, sizeof(join_request().pass));
        join_request().stored = stored;
        join_request().answered = false;
        join_request().waiting = true;
        busy_ = chosen_;
        failed_ = kNothing;
        step_ = Step::Choosing;
        idle_ms_ = 0;
    }

    void paint_list(Canvas &to) noexcept
    {
        const int count = shown();
        if (networks().count == 0) {
            note(to, text(StrId::WifiNone), DRV_LCD_DIM);
            return;
        }
        widgets::card(to, theme::kGutter, kContentY, theme::kContentW, count * kRowH);
        for (int i = 0; i < count; ++i) {
            const ui_kiosk_ap_t &ap = networks().row[i];
            const int y = row_y(i);
            if (i > 0) {
                widgets::divider(to, theme::kGutter, y, theme::kContentW);
            }
            const bool here = s_net.joined && strcmp(ap.ssid, s_net.ssid) == 0;
            const char *state =
                i == busy_ ? text(StrId::WifiJoining)
                           : (i == failed_ ? text(StrId::WifiWrongPass)
                                           : (here ? text(StrId::WifiJoined)
                                                   : (ap.saved ? text(StrId::WifiSaved)
                                                               : nullptr)));
            const widgets::Row what = { ap.ssid,
                                        state,
                                        widgets::Icon::None,
                                        0,
                                        (uint8_t)(i == failed_ ? DRV_LCD_DANGER
                                                               : (here ? DRV_LCD_ACCENT
                                                                       : DRV_LCD_INK)),
                                        signal_level(ap.rssi_dbm),
                                        // A row already saying where it stands
                                        // has no room left to say it is locked.
                                        (ap.open || state != nullptr) ? widgets::Icon::None
                                                                      : widgets::Icon::Lock };
            widgets::row(to, theme::kGutter, y, theme::kContentW, kRowH, what, held_ == i);
        }
    }

    void paint_keys(Canvas &to) noexcept
    {
        to.text(Font::Caption, theme::kGutter, kFieldHintY, theme::kContentW,
                networks().row[chosen_].ssid, DRV_LCD_DIM);
        field(to, typed_, text(StrId::WifiPassword));
        keyboard(to, set_, held_, text(StrId::WifiJoin));
    }

    Step step_ = Step::Looking;
    int held_ = kNothing;
    int chosen_ = kNothing;
    int busy_ = kNothing;                 // row the radio is joining
    int failed_ = kNothing;
    int set_ = 0;
    int64_t idle_ms_ = 0;
    char typed_[UI_KIOSK_WIFI_PASS_CAP] = {};
};

ScanScreen s_scan;
MenuScreen s_menu;
EnrolScreen s_enrol;
CaptureScreen s_capture;
PeopleScreen s_people;
SettingsScreen s_settings;
WifiScreen s_wifi;
DeviceScreen s_device;

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

Facts &facts() noexcept
{
    return s_facts;
}

ui_kiosk_net_t &net() noexcept
{
    return s_net;
}

Ticket &ticket() noexcept
{
    return s_ticket;
}

Restart &vision_reset() noexcept
{
    return s_vision_reset;
}

Level &brightness() noexcept
{
    return s_brightness;
}

Level &volume() noexcept
{
    return s_volume;
}

bool &language_changed() noexcept
{
    return s_language_changed;
}

Pending &pending() noexcept
{
    return s_pending;
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

People &people() noexcept
{
    return s_people_list;
}

void guide_box(int16_t out[4]) noexcept
{
    out[0] = kGuideX;
    out[1] = kGuideY;
    out[2] = kGuideX + kGuideW;
    out[3] = kGuideY + kGuideH;
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

Screen *device_screen() noexcept
{
    return &s_device;
}

}  // namespace ui
