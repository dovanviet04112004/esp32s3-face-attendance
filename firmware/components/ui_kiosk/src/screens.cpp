#include "screens.hpp"

#include <stdio.h>
#include <string.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "strings.hpp"
#include "widgets.hpp"

namespace ui {

namespace {

using theme::Font;
using theme::Stack;

constexpr int kHeadH = 44;
constexpr int kContentY = theme::kBarH + kHeadH + theme::kGapL;
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
constexpr int kTicketLineH = 22;          // the id line; the claim code takes the rest
constexpr int kBandH = 96;
constexpr int kBandY = APP_LCD_V_RES - kBandH - theme::kGutter;
constexpr int kMenuBox = 44;
constexpr int kRingR = 20;

constexpr int kSamples = 3;
constexpr int64_t kSampleGapMs = 400;
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

// Lower, upper, digits with the common marks, then the rest of printable ASCII (KEHOACH 7.6).
constexpr const char *kLayers[4] = { "qwertyuiopasdfghjklzxcvbnm",
                                     "QWERTYUIOPASDFGHJKLZXCVBNM",
                                     "1234567890@#$_&-+()*\"\':;!?",
                                     "[]{}#%^*+=_\\|~<>.,?!'/`$&@" };
constexpr int kLower = 0;
constexpr int kUpper = 1;
constexpr int kSymbols = 2;
constexpr int kMoreSymbols = 3;

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
constexpr int kPrev = -10;
constexpr int kNext = -11;

ScreenManager s_manager;
EnrolRequest s_request;
People s_people_list;
Pending s_pending;
// sync_task writes the answers and ui_task reads them, neither past a copy (KEHOACH 7.6).
portMUX_TYPE s_wifi_lock = portMUX_INITIALIZER_UNLOCKED;
struct WifiDesk {
    bool scan_wanted;
    bool swept;                           // a sweep has answered since boot
    uint32_t sweep_serial;
    Networks heard;
    bool join_waiting;
    JoinRequest join;
    uint32_t joined_serial;
    ui_kiosk_wifi_result_t joined;
    bool info_wanted;
    char info_ssid[UI_KIOSK_SSID_CAP];
    uint32_t info_serial;
    ui_kiosk_wifi_info_t info;
    bool saved_wanted;
    uint32_t saved_serial;
    int saved_count;
    char saved[UI_KIOSK_WIFI_SAVED_ROWS][UI_KIOSK_SSID_CAP];
    bool forget_waiting;
    char forget_ssid[UI_KIOSK_SSID_CAP];
    uint32_t forgotten_serial;
    bool forgotten;
} s_wifi_desk;
Facts s_facts;
ui_kiosk_net_t s_net;
Ticket s_ticket;
Update s_update = { UI_KIOSK_UPDATE_NONE, 0, UI_KIOSK_UPDATE_WHY_OTHER, false, 0, {} };
Level s_brightness = { 70, false, false };
Restart s_vision_reset = Restart::No;
Level s_volume = { 60, false, false };
bool s_language_changed = false;
bool s_recognition = true;

bool inside(int x, int y, int bx, int by, int bw, int bh)
{
    return x >= bx && x < bx + bw && y >= by && y < by + bh;
}

// A clock nothing has set reads 1970 boot time, which is a wrong hour, not an hour (KEHOACH 4.5.5h.1).
void clock_text(char *out, size_t cap)
{
    if (!s_net.clock_trusted) {
        strlcpy(out, "--:--", cap);
        return;
    }
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

// Bars say the radio holds a network; the mark beside them says the broker does not (KEHOACH 4.5.5h.1).
void wifi_mark(Canvas &to, int right, bool on_video)
{
    const int box = 22;
    const int x = right - box;
    widgets::wifi_bars(to, x, (theme::kBarH - box) / 2, box, s_net.joined ? signal_level(s_net.rssi_dbm) : 0,
                       DRV_LCD_INK, on_video ? DRV_LCD_EDGE : DRV_LCD_LINE);
    if (!s_net.joined || s_net.broker) {
        return;
    }
    const int w = theme::text_width(Font::Caption, "!");
    const int y = Canvas::centre_y(Font::Caption, 0, theme::kBarH);
    if (on_video) {
        to.text_on_video(Font::Caption, x - w - 2, y, w, "!", DRV_LCD_WARN);
    } else {
        to.text(Font::Caption, x - w - 2, y, w, "!", DRV_LCD_WARN);
    }
}

void status_bar(Canvas &to, bool on_video)
{
    const uint8_t ink = DRV_LCD_INK;
    char now[8] = { 0 };
    clock_text(now, sizeof(now));
    const int y = Canvas::centre_y(Font::Caption, 0, theme::kBarH);
    if (on_video) {
        to.text_on_video(Font::Caption, theme::kGutter, y, 80, now, ink);
    } else {
        to.text(Font::Caption, theme::kGutter, y, 80, now, ink);
    }
    wifi_mark(to, APP_LCD_H_RES - theme::kGutter, on_video);
}

void page(Canvas &to, const char *title, bool back)
{
    to.fill(0, 0, APP_LCD_H_RES, APP_LCD_V_RES, DRV_LCD_GROUND);
    status_bar(to, false);
    widgets::header(to, title, back);
}

// One page of a list main holds, under the pair of buttons Enrol and People share (KEHOACH 4.5.5h.3).
struct Pager {
    int first;
    int count;
    int total;
    int cap;                              // rows main hands down at most

    // The whole list fits without a pager; past that the pager takes the foot of the panel.
    bool paged() const noexcept { return total > list_fits(total, theme::kRowH, kListEnd); }

    static int caption_y() noexcept { return kFootY - theme::kGapS - theme::line_height(Font::Caption); }
    static int half_w() noexcept { return (theme::kContentW - theme::kGapM) / 2; }
    static int next_x() noexcept { return theme::kGutter + half_w() + theme::kGapM; }

    int size() const noexcept
    {
        const int bottom = paged() ? caption_y() - theme::kGapS : kListEnd;
        const int fits = list_fits(cap, theme::kRowH, bottom);
        return fits > 0 ? fits : 1;
    }

    int rows() const noexcept { return count < size() ? count : size(); }
    bool can_go_back() const noexcept { return first > 0; }
    bool can_go_on() const noexcept { return first + rows() < total; }
    int row_y(int i) const noexcept { return kContentY + i * theme::kRowH; }

    int hit(int x, int y) const noexcept
    {
        if (paged() && inside(x, y, theme::kGutter, kFootY, half_w(), theme::kButtonH)) {
            return can_go_back() ? kPrev : kNothing;
        }
        if (paged() && inside(x, y, next_x(), kFootY, half_w(), theme::kButtonH)) {
            return can_go_on() ? kNext : kNothing;
        }
        for (int i = 0; i < rows(); ++i) {
            if (inside(x, y, theme::kGutter, row_y(i), theme::kContentW, theme::kRowH)) {
                return i;
            }
        }
        return kNothing;
    }

    // The first row to ask main for once a pager button fired.
    int turned(int fired) const noexcept
    {
        const int to = first + (fired == kPrev ? -size() : size());
        return to < 0 ? 0 : to;
    }

    void paint(Canvas &to, int held) const noexcept
    {
        if (!paged()) {
            return;
        }
        char range[32];
        snprintf(range, sizeof(range), text(StrId::PageRangeFmt), first + 1, first + rows(), total);
        to.text(Font::Caption, theme::kGutter, caption_y(), theme::kContentW, range, DRV_LCD_DIM,
                Align::Centre);
        widgets::button(to, theme::kGutter, kFootY, half_w(), theme::kButtonH, text(StrId::PagePrev),
                        DRV_LCD_SURFACE, can_go_back() ? DRV_LCD_INK : DRV_LCD_LINE, held == kPrev);
        widgets::button(to, next_x(), kFootY, half_w(), theme::kButtonH, text(StrId::PageNext),
                        DRV_LCD_SURFACE, can_go_on() ? DRV_LCD_INK : DRV_LCD_LINE, held == kNext);
    }
};

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

// Where a name breaks to fit width: the last space that fits, else wherever the width runs out.
size_t wrap_at(Font face, const char *utf8, int width)
{
    if (theme::text_width(face, utf8) <= width) {
        return strlen(utf8);
    }
    char probe[STORAGE_NAME_CAP];
    size_t space = 0;
    size_t fits = 0;
    const char *at = utf8;
    while (*at != '\0') {
        const char *next = at;
        theme::next_code(&next);
        const size_t end = (size_t)(next - utf8);
        if (end >= sizeof(probe)) {
            break;
        }
        memcpy(probe, utf8, end);
        probe[end] = '\0';
        if (theme::text_width(face, probe) > width) {
            break;
        }
        if (*at == ' ') {
            space = (size_t)(at - utf8);
        }
        fits = end;
        at = next;
    }
    return space > 0 ? space : fits;
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
        case UI_KIOSK_FACT_RECOGNITION:
            return text(StrId::DeviceRecognition);
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
    const StrId shift = layer == kLower ? StrId::KeyUpper
                        : layer == kUpper ? StrId::KeyLower
                        : layer == kSymbols ? StrId::KeyMoreSymbols
                                            : StrId::KeyDigits;
    widgets::key_cap(to, shift_x(), row3, kWideKey, kKeyH, text(shift), widgets::Icon::None,
                     held == kShift, true);
    widgets::key_cap(to, del_x(), row3, kWideKey, kKeyH, "", widgets::Icon::Backspace,
                     held == kDel, true);
    const int row4 = bottom_row_y();
    widgets::key_cap(to, shift_x(), row4, kLayerKey, kKeyH,
                     text(layer >= kSymbols ? StrId::KeyLower : StrId::KeySymbols), widgets::Icon::None,
                     held == kLayer, true);
    widgets::key_cap(to, space_x(), row4, space_w(), kKeyH, "", widgets::Icon::None,
                     held == kSpace, false);
    to.card(enter_x(), row4, kEnterKey, kKeyH, theme::kKeyRadius,
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

// A long entry shows its end, where the typing is, behind a leading ellipsis (KEHOACH 7.6).
void field(Canvas &to, const char *typed, const char *hint)
{
    to.card(theme::kGutter, kFieldY, theme::kContentW, kFieldH, theme::kRadiusS, DRV_LCD_SURFACE);
    const int x = theme::kGutter + theme::kGapM;
    const int y = Canvas::centre_y(Font::Body, kFieldY, kFieldH);
    const int room = theme::kContentW - 2 * theme::kGapM;
    if (typed[0] == '\0') {
        to.text(Font::Body, x, y, room, hint, DRV_LCD_DIM);
        return;
    }
    const char *tail = typed;
    const int dots = theme::text_width(Font::Body, "…");
    while (theme::text_width(Font::Body, tail) > room && *tail != '\0') {
        theme::next_code(&tail);
    }
    if (tail == typed) {
        to.text(Font::Body, x, y, room, typed, DRV_LCD_INK);
        return;
    }
    while (theme::text_width(Font::Body, tail) > room - dots && *tail != '\0') {
        theme::next_code(&tail);
    }
    char shown[UI_KIOSK_WIFI_PASS_CAP + 4];
    snprintf(shown, sizeof(shown), "…%s", tail);
    to.text(Font::Body, x, y, room, shown, DRV_LCD_INK);
}

// Lines about the kiosk itself, not the face, in the gap above the guide (KEHOACH 4.5.5h.1).
void ticket_line(Canvas &to)
{
    char line[64] = { 0 };
    if (s_update.state == UI_KIOSK_UPDATE_DONE) {
        snprintf(line, sizeof(line), text(StrId::UpdateDoneFmt), s_update.version);
        to.text_on_video(Font::Caption, kWideX,
                         Canvas::centre_y(Font::Caption, theme::kBarH, kGuideY - theme::kBarH), kWideW,
                         line, DRV_LCD_OK, Align::Centre);
        return;
    }
    switch (s_ticket.state) {
    case UI_KIOSK_TICKET_WAITING:
        snprintf(line, sizeof(line), text(StrId::TicketWaitingFmt), s_ticket.device_id);
        break;
    case UI_KIOSK_TICKET_REFUSED: strlcpy(line, text(StrId::TicketRefused), sizeof(line)); break;
    case UI_KIOSK_TICKET_NO_TOKEN: strlcpy(line, text(StrId::TicketNoToken), sizeof(line)); break;
    case UI_KIOSK_TICKET_OFFLINE: strlcpy(line, text(StrId::TicketOffline), sizeof(line)); break;
    default: break;
    }
    // A kiosk that recognises nobody says so first; a claim code still shows under it.
    if (!s_recognition) {
        strlcpy(line, text(StrId::ScanRecognitionOff), sizeof(line));
    }
    if (line[0] == '\0') {
        return;
    }
    const bool coded = s_ticket.state == UI_KIOSK_TICKET_WAITING && strlen(s_ticket.claim) == 6;
    const int split = coded ? theme::kBarH + kTicketLineH : kGuideY;
    to.text_on_video(Font::Caption, kWideX,
                     Canvas::centre_y(Font::Caption, theme::kBarH, split - theme::kBarH), kWideW,
                     line, DRV_LCD_WARN, Align::Centre);
    if (!coded) {
        return;
    }
    char grouped[8] = { 0 };
    snprintf(grouped, sizeof(grouped), "%.3s %.3s", s_ticket.claim, s_ticket.claim + 3);
    snprintf(line, sizeof(line), text(StrId::TicketClaimFmt), grouped);
    to.text_on_video(Font::Strong, kWideX, Canvas::centre_y(Font::Strong, split, kGuideY - split),
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
        wifi_mark(to, APP_LCD_H_RES - kMenuBox - theme::kGapS, true);
        widgets::icon(to, APP_LCD_H_RES - kMenuBox, 0, kMenuBox, widgets::Icon::Menu,
                      held_ ? DRV_LCD_ACCENT : DRV_LCD_INK);
        ticket_line(to);
        // A guide nobody answers is the one thing worse than saying recognition is off (KEHOACH 7.7).
        if (!s_recognition) {
            return;
        }

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
        // The card is the only word on whom the kiosk recognised, so the name takes two lines ahead of a cut.
        const size_t split = wrap_at(Font::Body, who, room);
        char first[STORAGE_NAME_CAP];
        strlcpy(first, who, split + 1 < sizeof(first) ? split + 1 : sizeof(first));
        const char *rest = who + split;
        while (*rest == ' ') {
            ++rest;
        }
        const int body = theme::line_height(Font::Body);
        const int lines = rest[0] != '\0' ? 2 : 1;
        int y = cy - (lines * body + theme::line_height(Font::Caption) + 4) / 2;
        to.text(Font::Body, text_x, y, room, first, DRV_LCD_INK);
        if (lines == 2) {
            y += body;
            to.text(Font::Body, text_x, y, room, rest, DRV_LCD_INK);
        }
        to.text(Font::Caption, text_x, y + body + 4, room, text(StrId::ScanCheckedIn), DRV_LCD_OK);
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
        widgets::card(to, theme::kGutter, kContentY, theme::kContentW, kRows * theme::kRowH);
        for (int i = 0; i < kRows; ++i) {
            const int y = kContentY + i * theme::kRowH;
            if (i > 0) {
                widgets::divider(to, theme::kGutter, y, theme::kContentW);
            }
            const widgets::Row what = { text(kLabels[i]), nullptr, kIcons[i], kTints[i],
                                        DRV_LCD_INK, -1,          widgets::Icon::None };
            widgets::row(to, theme::kGutter, y, theme::kContentW, theme::kRowH, what, held_ == i);
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
            if (inside(x, y, theme::kGutter, kContentY + i * theme::kRowH, theme::kContentW, theme::kRowH)) {
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
        // A drag stays with the slider it began on, wherever the finger drifts.
        if (down && (held_ == kBright || held_ == kVolume)) {
            drag(held_, x);
            return true;
        }
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
        widgets::card(to, theme::kGutter, lang_y(), theme::kContentW, 2 * theme::kRowH);
        widgets::segment_row(to, theme::kGutter, lang_y(), theme::kContentW, theme::kRowH,
                             widgets::Icon::Globe, DRV_LCD_ACCENT, text(StrId::SettingsLanguage),
                             language_badge(Lang::Vi), language_badge(Lang::En),
                             language() == Lang::En, held_ == kLanguage);
        widgets::divider(to, theme::kGutter, device_y(), theme::kContentW);
        const widgets::Row me = { text(StrId::SettingsDevice), nullptr, widgets::Icon::Device,
                                  DRV_LCD_DIM,        DRV_LCD_INK, -1, widgets::Icon::None };
        widgets::row(to, theme::kGutter, device_y(), theme::kContentW, theme::kRowH, me,
                     held_ == kDevice);

        widgets::card(to, theme::kGutter, wifi_y(), theme::kContentW, theme::kRowH);
        const widgets::Row net = { text(StrId::WifiTitle),
                                   s_net.joined ? s_net.ssid : text(StrId::SettingsNotJoined),
                                   widgets::Icon::Wifi,
                                   DRV_LCD_ACCENT,
                                   DRV_LCD_INK,
                                   -1,
                                   widgets::Icon::None };
        widgets::row(to, theme::kGutter, wifi_y(), theme::kContentW, theme::kRowH, net, held_ == kWifi);

        widgets::group_label(to, theme::kGutter, label_y(), theme::kContentW,
                             text(StrId::SettingsDisplay));
        widgets::card(to, theme::kGutter, slider_y(0), theme::kContentW, 2 * theme::kRowH);
        widgets::slider_row(to, theme::kGutter, slider_y(0), theme::kContentW, theme::kRowH,
                            widgets::Icon::Brightness, DRV_LCD_WARN, s_brightness.percent,
                            DRV_LCD_ACCENT);
        widgets::divider(to, theme::kGutter, slider_y(1), theme::kContentW);
        widgets::slider_row(to, theme::kGutter, slider_y(1), theme::kContentW, theme::kRowH,
                            widgets::Icon::Volume, DRV_LCD_OK, s_volume.percent, DRV_LCD_ACCENT);
    }

private:
    static constexpr int kLanguage = 0;
    static constexpr int kDevice = 1;
    static constexpr int kWifi = 2;
    static constexpr int kBright = 3;
    static constexpr int kVolume = 4;

    static int lang_y() noexcept { return kContentY; }
    static int device_y() noexcept { return lang_y() + theme::kRowH; }
    // Four rows and two sliders leave 25 px under the last card at kGapM, and
    // none at kGapL, so the cards sit a notch closer here than elsewhere.
    static int wifi_y() noexcept { return device_y() + theme::kRowH + theme::kGapM; }
    static int label_y() noexcept { return wifi_y() + theme::kRowH + theme::kGapM; }
    static int slider_y(int i) noexcept
    {
        return label_y() + theme::line_height(Font::Caption) + theme::kGapS + i * theme::kRowH;
    }

    // The icon tile is no part of the track, so a tap on it sets nothing.
    static bool on_slider(int x, int y, int which) noexcept
    {
        const int at = slider_y(which == kBright ? 0 : 1);
        const int grip = widgets::slider_grip_x(theme::kGutter);
        return inside(x, y, grip, at, theme::kGutter + theme::kContentW - grip, theme::kRowH);
    }

    static int row_at(int x, int y) noexcept
    {
        if (widgets::on_back(x, y)) {
            return kBack;
        }
        if (inside(x, y, theme::kGutter, lang_y(), theme::kContentW, theme::kRowH)) {
            return kLanguage;
        }
        if (inside(x, y, theme::kGutter, device_y(), theme::kContentW, theme::kRowH)) {
            return kDevice;
        }
        if (inside(x, y, theme::kGutter, wifi_y(), theme::kContentW, theme::kRowH)) {
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
        const int percent = widgets::slider_percent(x, theme::kGutter, theme::kContentW);
        const int floor = which == kBright ? CONFIG_UI_MIN_BRIGHTNESS : 0;
        level.percent = (uint8_t)(percent < floor ? floor : percent);
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
        held_ = kNothing;
        s_pending.wanted = true;
    }

    bool on_touch(int x, int y, bool down) noexcept override
    {
        const int hit = widgets::on_back(x, y) ? kBack : pager().hit(x, y);
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
        if (fire == kPrev || fire == kNext) {
            s_pending.asked = pager().turned(fire);
            s_pending.wanted = true;
            return true;
        }
        if (fire < 0) {
            return true;
        }
        // Only people the server assigned are enrolled here; a kiosk mints no id (KEHOACH 7.5).
        enrol_request().employee_id = s_pending.row[fire].employee_id;
        strlcpy(enrol_request().name, s_pending.row[fire].name, sizeof(enrol_request().name));
        manager().go(ScreenId::Capture);
        return true;
    }

    void paint(Canvas &to, const Sight &seen) noexcept override
    {
        (void)seen;
        page(to, text(StrId::MenuEnrol), true);
        const Pager list = pager();
        const int count = list.rows();
        if (count == 0) {
            widgets::card(to, theme::kGutter, kContentY, theme::kContentW, theme::kRowH);
            to.text(Font::Body, theme::kGutter, Canvas::centre_y(Font::Body, kContentY, theme::kRowH),
                    theme::kContentW, text(StrId::EnrolNobody), DRV_LCD_INK, Align::Centre);
            to.text(Font::Caption, theme::kGutter, kContentY + theme::kRowH + theme::kGapM,
                    theme::kContentW, text(StrId::EnrolNobodyHint), DRV_LCD_DIM, Align::Centre);
            return;
        }
        widgets::card(to, theme::kGutter, kContentY, theme::kContentW, count * theme::kRowH);
        for (int i = 0; i < count; ++i) {
            const int y = list.row_y(i);
            if (i > 0) {
                widgets::divider(to, theme::kGutter, y, theme::kContentW);
            }
            // The kiosk has no employee code, and the server's row id means nothing at the door.
            const char *tail = s_pending.row[i].retake ? text(StrId::EnrolRetake) : nullptr;
            const widgets::Row what = { s_pending.row[i].name, tail,
                                        widgets::Icon::PersonAdd, DRV_LCD_ACCENT,
                                        DRV_LCD_INK, -1, widgets::Icon::None, true };
            widgets::row(to, theme::kGutter, y, theme::kContentW, theme::kRowH, what, held_ == i);
        }
        list.paint(to, held_);
    }

private:
    static Pager pager() noexcept
    {
        return { s_pending.first, s_pending.count, s_pending.total, UI_KIOSK_PENDING_ROWS };
    }

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

    bool live() const noexcept { return !done() && !failed_; }

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
        // Whose face is being taken stays on the glass, so it cannot land under the wrong name.
        to.text_on_video(Font::Body, kWideX, Canvas::centre_y(Font::Body, 0, theme::kBarH), kWideW,
                         enrol_request().name, DRV_LCD_INK, Align::Centre);
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
        if (!s_recognition) {
            enrol_request().waiting = false;
            failed_ = true;
            why_ = text(StrId::CaptureNoRecognition);
        }
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

// Read only: retake and removal are dashboard actions, since the menu has no lock (KEHOACH 7.5).
class PeopleScreen final : public Screen {
public:
    bool opaque() const noexcept override { return true; }

    void on_enter() noexcept override
    {
        people().wanted = true;
        held_ = kNothing;
    }

    bool on_touch(int x, int y, bool down) noexcept override
    {
        const int hit = widgets::on_back(x, y) ? kBack : pager().hit(x, y);
        if (down) {
            held_ = hit == kBack || hit == kPrev || hit == kNext ? hit : kNothing;
            return true;
        }
        const int fire = held_ == hit ? hit : kNothing;
        held_ = kNothing;
        if (fire == kBack) {
            manager().go(ScreenId::Menu);
        } else if (fire == kPrev || fire == kNext) {
            people().asked = pager().turned(fire);
            people().wanted = true;
        }
        return true;
    }

    void paint(Canvas &to, const Sight &seen) noexcept override
    {
        (void)seen;
        page(to, text(StrId::MenuPeople), true);
        const Pager list = pager();
        const int count = list.rows();
        if (count == 0) {
            to.text(Font::Body, theme::kGutter, kContentY, theme::kContentW, text(StrId::PeopleEmpty),
                    DRV_LCD_DIM, Align::Centre);
            return;
        }
        widgets::card(to, theme::kGutter, kContentY, theme::kContentW, count * theme::kRowH);
        for (int i = 0; i < count; ++i) {
            const ui_kiosk_person_t &who = people().row[i];
            const int y = list.row_y(i);
            if (i > 0) {
                widgets::divider(to, theme::kGutter, y, theme::kContentW);
            }
            char tail[24];
            snprintf(tail, sizeof(tail), text(StrId::PeopleTemplatesFmt), (unsigned)who.templates);
            const widgets::Row what = { who.name[0] != '\0' ? who.name : text(StrId::PeopleUnnamed),
                                        tail,
                                        widgets::Icon::Person,
                                        DRV_LCD_ACCENT,
                                        DRV_LCD_INK,
                                        -1,
                                        widgets::Icon::None,
                                        true };
            widgets::row(to, theme::kGutter, y, theme::kContentW, theme::kRowH, what, false);
        }
        list.paint(to, held_);
    }

private:
    static Pager pager() noexcept
    {
        return { people().first, people().count, people().total, UI_KIOSK_PEOPLE_ROWS };
    }

    int held_ = kNothing;
};

// Works the way a phone's Wi-Fi page does: list, join, info, forget (KEHOACH 7.6).
class WifiScreen final : public Screen {
public:
    bool opaque() const noexcept override { return true; }

    void on_enter() noexcept override
    {
        held_ = kNothing;
        busy_[0] = '\0';
        failed_[0] = '\0';
        chosen_[0] = '\0';
        typed_[0] = '\0';
        set_ = kLower;
        armed_ = false;
        step_ = sweep_seen_ != 0 ? Step::Choosing : Step::Looking;
        rescan();
    }

    bool tick(uint32_t dt_ms, const Sight &seen) noexcept override
    {
        (void)seen;
        bool changed = take_answers();
        // A sweep lands between touches and outside a join, so no row moves under a finger.
        if (held_ == kNothing && busy_[0] == '\0' && take_sweep()) {
            changed = true;
        }
        if (step_ != Step::Choosing || busy_[0] != '\0' || scanning_) {
            return changed;
        }
        idle_ms_ += dt_ms;
        if (idle_ms_ >= kRescanMs) {
            rescan();
            changed = true;
        }
        return changed;
    }

    bool on_touch(int x, int y, bool down) noexcept override
    {
        const int hit = hit_at(x, y);
        if (down) {
            held_ = hit;
            return true;
        }
        const int fire = held_ == hit ? hit : kNothing;
        held_ = kNothing;
        // One tap arms a forget and the next fires it; any other tap stands it down.
        if (fire != kForget) {
            armed_ = false;
        }
        if (fire == kNothing) {
            return true;
        }
        if (fire == kBack) {
            back();
            return true;
        }
        switch (step_) {
            case Step::Typing: return typing(fire);
            case Step::Info: return info_tap(fire);
            case Step::Saved: return saved_tap(fire);
            default: return choosing(fire);
        }
    }

    void paint(Canvas &to, const Sight &seen) noexcept override
    {
        (void)seen;
        switch (step_) {
            case Step::Typing:
                page(to, text(StrId::WifiTitle), true);
                paint_keys(to);
                return;
            case Step::Info:
                page(to, info_.ssid, true);
                paint_info(to);
                return;
            case Step::Saved:
                page(to, text(StrId::WifiSavedNetworks), true);
                paint_saved(to);
                return;
            case Step::Looking:
                page(to, text(StrId::WifiTitle), true);
                note(to, text(StrId::WifiLooking), DRV_LCD_DIM);
                return;
            default:
                page(to, text(StrId::WifiTitle), true);
                paint_list(to);
                if (scanning_) {
                    paint_scanning(to);
                }
                return;
        }
    }

private:
    enum class Step : uint8_t { Looking, Choosing, Typing, Info, Saved };
    static constexpr int kSavedRow = -20;
    static constexpr int kForget = -21;

    struct Saved {
        int count;
        char names[UI_KIOSK_WIFI_SAVED_ROWS][UI_KIOSK_SSID_CAP];
    };

    static void note(Canvas &to, const char *line, uint8_t tone) noexcept
    {
        to.text(Font::Body, theme::kGutter, kContentY, theme::kContentW, line, tone, Align::Centre);
    }

    static int row_y(int i) noexcept { return kContentY + i * theme::kRowH; }

    static bool here(const char *ssid) noexcept { return s_net.joined && strcmp(ssid, s_net.ssid) == 0; }

    // The last row the panel holds is the way into the saved networks.
    int list_rows() const noexcept
    {
        const int fits = list_fits(UI_KIOSK_WIFI_ROWS + 1, theme::kRowH, kListEnd) - 1;
        return list_.count < fits ? list_.count : (fits > 0 ? fits : 0);
    }

    int saved_row_y() const noexcept
    {
        return list_.count == 0 ? kContentY + theme::line_height(Font::Body) + theme::kGapL : row_y(list_rows());
    }

    int info_rows() const noexcept { return info_.here ? 3 : 1; }
    int forget_y() const noexcept { return kContentY + info_rows() * theme::kRowH + theme::kGapL; }

    int saved_rows() const noexcept
    {
        const int fits = list_fits(saved_.count, theme::kRowH, kListEnd);
        return saved_.count < fits ? saved_.count : fits;
    }

    static int row_hit(int x, int y, int rows) noexcept
    {
        for (int i = 0; i < rows; ++i) {
            if (inside(x, y, theme::kGutter, row_y(i), theme::kContentW, theme::kRowH)) {
                return i;
            }
        }
        return kNothing;
    }

    // Only the back arrow leaves typing; a touch on the field or its hint keeps the entry.
    int hit_at(int x, int y) const noexcept
    {
        if (widgets::on_back(x, y)) {
            return kBack;
        }
        switch (step_) {
            case Step::Typing:
                return y >= kKeyTop - kKeyVGap ? key_hit(x, y) : kNothing;
            case Step::Info:
                return inside(x, y, theme::kGutter, forget_y(), theme::kContentW, theme::kButtonH) ? kForget
                                                                                                   : kNothing;
            case Step::Saved:
                return row_hit(x, y, saved_rows());
            case Step::Choosing:
                if (inside(x, y, theme::kGutter, saved_row_y(), theme::kContentW, theme::kRowH)) {
                    return kSavedRow;
                }
                return row_hit(x, y, list_rows());
            default:
                return kNothing;
        }
    }

    void rescan() noexcept
    {
        wifi_ask_scan();
        scanning_ = true;
        idle_ms_ = 0;
    }

    bool take_sweep() noexcept
    {
        portENTER_CRITICAL(&s_wifi_lock);
        const bool fresh = s_wifi_desk.sweep_serial != sweep_seen_;
        if (fresh) {
            list_ = s_wifi_desk.heard;
            sweep_seen_ = s_wifi_desk.sweep_serial;
        }
        portEXIT_CRITICAL(&s_wifi_lock);
        if (!fresh) {
            return false;
        }
        scanning_ = false;
        idle_ms_ = 0;
        if (step_ == Step::Looking) {
            step_ = Step::Choosing;
        }
        return true;
    }

    bool take_answers() noexcept
    {
        portENTER_CRITICAL(&s_wifi_lock);
        const bool joined = s_wifi_desk.joined_serial != joined_seen_;
        const ui_kiosk_wifi_result_t result = s_wifi_desk.joined;
        joined_seen_ = s_wifi_desk.joined_serial;
        const bool informed = s_wifi_desk.info_serial != info_seen_;
        if (informed && strcmp(s_wifi_desk.info.ssid, info_.ssid) == 0) {
            info_ = s_wifi_desk.info;
        }
        info_seen_ = s_wifi_desk.info_serial;
        const bool listed = s_wifi_desk.saved_serial != saved_seen_;
        if (listed) {
            saved_.count = s_wifi_desk.saved_count;
            memcpy(saved_.names, s_wifi_desk.saved, sizeof(saved_.names));
        }
        saved_seen_ = s_wifi_desk.saved_serial;
        const bool forgot = s_wifi_desk.forgotten_serial != forgotten_seen_;
        const bool gone = s_wifi_desk.forgotten;
        forgotten_seen_ = s_wifi_desk.forgotten_serial;
        portEXIT_CRITICAL(&s_wifi_lock);
        if (joined) {
            if (result == UI_KIOSK_WIFI_JOINED) {
                failed_[0] = '\0';
            } else {
                strlcpy(failed_, busy_, sizeof(failed_));
                failure_ = result;
            }
            busy_[0] = '\0';
            // The joined network moves to the top, and the next sweep says so.
            rescan();
        }
        if (forgot && gone) {
            step_ = Step::Choosing;
            rescan();
        }
        return joined || informed || listed || forgot;
    }

    void back() noexcept
    {
        if (step_ == Step::Typing || step_ == Step::Saved) {
            step_ = Step::Choosing;
            idle_ms_ = 0;
            return;
        }
        if (step_ == Step::Info) {
            step_ = info_from_;
            if (step_ == Step::Saved) {
                wifi_ask_saved();
            }
            return;
        }
        manager().go(ScreenId::Settings);
    }

    void open_info(const char *ssid, Step from) noexcept
    {
        memset(&info_, 0, sizeof(info_));
        strlcpy(info_.ssid, ssid, sizeof(info_.ssid));
        info_from_ = from;
        armed_ = false;
        step_ = Step::Info;
        wifi_ask_info(ssid);
    }

    bool choosing(int fire) noexcept
    {
        if (fire == kSavedRow) {
            saved_.count = 0;
            step_ = Step::Saved;
            wifi_ask_saved();
            return true;
        }
        if (fire < 0 || fire >= list_rows() || busy_[0] != '\0') {
            return true;
        }
        const ui_kiosk_ap_t &ap = list_.row[fire];
        if (here(ap.ssid)) {
            open_info(ap.ssid, Step::Choosing);
            return true;
        }
        strlcpy(chosen_, ap.ssid, sizeof(chosen_));
        typed_[0] = '\0';
        failed_[0] = '\0';
        // A network NVS already holds joins on one touch, the way a phone does.
        if (ap.open || ap.saved) {
            join(ap.saved);
            return true;
        }
        step_ = Step::Typing;
        set_ = kLower;
        return true;
    }

    bool saved_tap(int fire) noexcept
    {
        if (fire >= 0 && fire < saved_rows()) {
            open_info(saved_.names[fire], Step::Saved);
        }
        return true;
    }

    bool info_tap(int fire) noexcept
    {
        if (fire != kForget) {
            return true;
        }
        if (armed_) {
            wifi_ask_forget(info_.ssid);
        }
        armed_ = !armed_;
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
            set_ = set_ >= kSymbols ? (set_ == kSymbols ? kMoreSymbols : kSymbols)
                                    : (set_ == kUpper ? kLower : kUpper);
            return true;
        }
        if (fire == kLayer) {
            set_ = set_ >= kSymbols ? kLower : kSymbols;
            return true;
        }
        if (fire == kOk) {
            join(false);
            return true;
        }
        if (at + 1 >= sizeof(typed_)) {
            return true;
        }
        typed_[at] = fire == kSpace ? ' ' : kLayers[set_][fire];
        typed_[at + 1] = '\0';
        return true;
    }

    void join(bool stored) noexcept
    {
        JoinRequest ask = {};
        ask.stored = stored;
        strlcpy(ask.ssid, chosen_, sizeof(ask.ssid));
        strlcpy(ask.pass, typed_, sizeof(ask.pass));
        wifi_ask_join(ask);
        strlcpy(busy_, chosen_, sizeof(busy_));
        failed_[0] = '\0';
        step_ = Step::Choosing;
        idle_ms_ = 0;
    }

    static const char *failure_text(ui_kiosk_wifi_result_t why) noexcept
    {
        switch (why) {
            case UI_KIOSK_WIFI_WRONG_PASSWORD: return text(StrId::WifiWrongPass);
            case UI_KIOSK_WIFI_NOT_FOUND: return text(StrId::WifiNotFound);
            case UI_KIOSK_WIFI_TIMED_OUT: return text(StrId::WifiTimedOut);
            default: return text(StrId::WifiJoinFailed);
        }
    }

    static const char *security_text(ui_kiosk_wifi_sec_t security) noexcept
    {
        switch (security) {
            case UI_KIOSK_WIFI_SEC_OPEN: return text(StrId::WifiSecOpen);
            case UI_KIOSK_WIFI_SEC_WEP: return text(StrId::WifiSecWep);
            case UI_KIOSK_WIFI_SEC_WPA: return text(StrId::WifiSecWpa);
            case UI_KIOSK_WIFI_SEC_WPA2: return text(StrId::WifiSecWpa2);
            case UI_KIOSK_WIFI_SEC_WPA3: return text(StrId::WifiSecWpa3);
            default: return text(StrId::WifiSecOther);
        }
    }

    void paint_scanning(Canvas &to) const noexcept
    {
        const char *line = text(StrId::WifiScanning);
        const int w = theme::text_width(Font::Caption, line);
        to.text(Font::Caption, APP_LCD_H_RES - theme::kGutter - w,
                Canvas::centre_y(Font::Caption, theme::kBarH, kHeadH), w, line, DRV_LCD_DIM);
    }

    void paint_list(Canvas &to) const noexcept
    {
        const int rows = list_rows();
        if (list_.count == 0) {
            note(to, text(StrId::WifiNone), DRV_LCD_DIM);
        }
        widgets::card(to, theme::kGutter, rows > 0 ? kContentY : saved_row_y(), theme::kContentW,
                      (rows + 1) * theme::kRowH);
        for (int i = 0; i < rows; ++i) {
            const ui_kiosk_ap_t &ap = list_.row[i];
            const int y = row_y(i);
            if (i > 0) {
                widgets::divider(to, theme::kGutter, y, theme::kContentW);
            }
            const bool now_here = here(ap.ssid);
            const bool trying = strcmp(ap.ssid, busy_) == 0;
            const bool refused = strcmp(ap.ssid, failed_) == 0;
            const char *state = trying    ? text(StrId::WifiJoining)
                                : refused ? failure_text(failure_)
                                : now_here ? text(StrId::WifiJoined)
                                : ap.saved ? text(StrId::WifiSaved)
                                           : nullptr;
            const uint8_t ink = refused ? DRV_LCD_WARN : (now_here ? DRV_LCD_ACCENT : DRV_LCD_INK);
            const widgets::Icon trail = ap.open ? widgets::Icon::None : widgets::Icon::Lock;
            const widgets::Row what = { ap.ssid, state, widgets::Icon::None, 0, ink, signal_level(ap.rssi_dbm), trail,
                                        true };
            widgets::row(to, theme::kGutter, y, theme::kContentW, theme::kRowH, what, held_ == i);
        }
        const int y = saved_row_y();
        if (rows > 0) {
            widgets::divider(to, theme::kGutter, y, theme::kContentW);
        }
        const widgets::Row saved = { text(StrId::WifiSavedNetworks), nullptr, widgets::Icon::List, DRV_LCD_DIM,
                                     DRV_LCD_INK, -1, widgets::Icon::None };
        widgets::row(to, theme::kGutter, y, theme::kContentW, theme::kRowH, saved, held_ == kSavedRow);
    }

    void paint_info(Canvas &to) const noexcept
    {
        widgets::card(to, theme::kGutter, kContentY, theme::kContentW, info_rows() * theme::kRowH);
        if (!info_.here) {
            const widgets::Row away = { text(StrId::WifiNotHere), nullptr, widgets::Icon::Wifi, DRV_LCD_DIM,
                                        DRV_LCD_INK, -1, widgets::Icon::None };
            widgets::row(to, theme::kGutter, row_y(0), theme::kContentW, theme::kRowH, away, false);
        } else {
            char dbm[16];
            snprintf(dbm, sizeof(dbm), text(StrId::WifiDbmFmt), info_.rssi_dbm);
            const widgets::Row signal = { text(StrId::WifiSignal), dbm, widgets::Icon::None, 0, DRV_LCD_INK,
                                          signal_level(info_.rssi_dbm), widgets::Icon::None, true };
            const widgets::Row address = { text(StrId::WifiAddress), info_.ip, widgets::Icon::Globe, DRV_LCD_DIM,
                                           DRV_LCD_INK, -1, widgets::Icon::None, true };
            const widgets::Row lock = { text(StrId::WifiSecurity), security_text(info_.security), widgets::Icon::Lock,
                                        DRV_LCD_DIM, DRV_LCD_INK, -1, widgets::Icon::None, true };
            widgets::row(to, theme::kGutter, row_y(0), theme::kContentW, theme::kRowH, signal, false);
            widgets::divider(to, theme::kGutter, row_y(1), theme::kContentW);
            widgets::row(to, theme::kGutter, row_y(1), theme::kContentW, theme::kRowH, address, false);
            widgets::divider(to, theme::kGutter, row_y(2), theme::kContentW);
            widgets::row(to, theme::kGutter, row_y(2), theme::kContentW, theme::kRowH, lock, false);
        }
        widgets::button(to, theme::kGutter, forget_y(), theme::kContentW, theme::kButtonH,
                        text(armed_ ? StrId::WifiForgetConfirm : StrId::WifiForget), DRV_LCD_DANGER, DRV_LCD_INK,
                        held_ == kForget);
    }

    void paint_saved(Canvas &to) const noexcept
    {
        const int rows = saved_rows();
        if (rows == 0) {
            note(to, text(StrId::WifiNoneSaved), DRV_LCD_DIM);
            return;
        }
        widgets::card(to, theme::kGutter, kContentY, theme::kContentW, rows * theme::kRowH);
        for (int i = 0; i < rows; ++i) {
            const int y = row_y(i);
            if (i > 0) {
                widgets::divider(to, theme::kGutter, y, theme::kContentW);
            }
            const bool now_here = here(saved_.names[i]);
            const widgets::Row what = { saved_.names[i], now_here ? text(StrId::WifiJoined) : nullptr,
                                        widgets::Icon::Wifi, DRV_LCD_ACCENT,
                                        (uint8_t)(now_here ? DRV_LCD_ACCENT : DRV_LCD_INK), -1,
                                        widgets::Icon::None, true };
            widgets::row(to, theme::kGutter, y, theme::kContentW, theme::kRowH, what, held_ == i);
        }
    }

    void paint_keys(Canvas &to) noexcept
    {
        to.text(Font::Caption, theme::kGutter, kFieldHintY, theme::kContentW, chosen_, DRV_LCD_DIM);
        field(to, typed_, text(StrId::WifiPassword));
        keyboard(to, set_, held_, text(StrId::WifiJoin));
    }

    Step step_ = Step::Looking;
    Step info_from_ = Step::Choosing;
    Networks list_ = {};                  // what the panel shows, a copy of the last sweep taken
    Saved saved_ = {};
    ui_kiosk_wifi_info_t info_ = {};
    ui_kiosk_wifi_result_t failure_ = UI_KIOSK_WIFI_JOINED;
    int held_ = kNothing;
    int set_ = kLower;
    bool armed_ = false;
    bool scanning_ = false;
    int64_t idle_ms_ = 0;
    uint32_t sweep_seen_ = 0;
    uint32_t joined_seen_ = 0;
    uint32_t info_seen_ = 0;
    uint32_t saved_seen_ = 0;
    uint32_t forgotten_seen_ = 0;
    char chosen_[UI_KIOSK_SSID_CAP] = {};                // the network typed for, by name
    char busy_[UI_KIOSK_SSID_CAP] = {};                  // the network the radio is joining
    char failed_[UI_KIOSK_SSID_CAP] = {};                // the network that refused the last join
    char typed_[UI_KIOSK_WIFI_PASS_CAP] = {};
};

// The whole panel while an update runs, so nobody stands at a viewfinder nothing answers (KEHOACH 7.7).
class UpdateScreen final : public Screen {
public:
    bool opaque() const noexcept override { return true; }

    void paint(Canvas &to, const Sight &seen) noexcept override
    {
        (void)seen;
        const bool failed = s_update.state == UI_KIOSK_UPDATE_FAILED;
        page(to, text(failed ? StrId::UpdateFailed : StrId::UpdateTitle), false);
        Stack stack(kContentY);
        char line[64] = { 0 };
        if (s_update.version[0] != '\0') {
            snprintf(line, sizeof(line), text(StrId::UpdateVersionFmt), s_update.version);
            to.text(Font::Body, theme::kGutter, stack.take(theme::line_height(Font::Body)),
                    theme::kContentW, line, DRV_LCD_DIM, Align::Centre);
        }
        if (failed) {
            to.text(Font::Strong, theme::kGutter, stack.take(theme::line_height(Font::Strong)),
                    theme::kContentW, why(), DRV_LCD_WARN, Align::Centre);
            snprintf(line, sizeof(line), text(StrId::UpdateResumeFmt), (unsigned)s_update.resume_s);
            to.text(Font::Body, theme::kGutter, stack.take(theme::line_height(Font::Body)),
                    theme::kContentW, line, DRV_LCD_DIM, Align::Centre);
            return;
        }
        stack.skip(theme::kGapL);
        const int bar_y = stack.take(kTrackH, theme::kGapL);
        to.card(theme::kGutter, bar_y, theme::kContentW, kTrackH, kTrackH / 2, DRV_LCD_LINE);
        const int filled = theme::kContentW * shown_percent() / 100;
        if (filled > 0) {
            to.card(theme::kGutter, bar_y, filled > kTrackH ? filled : kTrackH, kTrackH, kTrackH / 2,
                    DRV_LCD_ACCENT);
        }
        to.text(Font::Strong, theme::kGutter, stack.take(theme::line_height(Font::Strong)),
                theme::kContentW, phase(line, sizeof(line)), DRV_LCD_INK, Align::Centre);
        to.text(Font::Caption, theme::kGutter, stack.take(theme::line_height(Font::Caption)),
                theme::kContentW, text(StrId::UpdatePaused), DRV_LCD_DIM, Align::Centre);
        if (s_update.capture_dropped) {
            to.text(Font::Caption, theme::kGutter, stack.take(theme::line_height(Font::Caption)),
                    theme::kContentW, text(StrId::UpdateCaptureDropped), DRV_LCD_WARN, Align::Centre);
        }
    }

private:
    static constexpr int kTrackH = 12;

    static int shown_percent() noexcept
    {
        switch (s_update.state) {
        case UI_KIOSK_UPDATE_FETCHING: return s_update.percent;
        case UI_KIOSK_UPDATE_CHECKING:
        case UI_KIOSK_UPDATE_RESTARTING: return 100;
        default: return 0;
        }
    }

    static const char *phase(char *line, size_t cap) noexcept
    {
        switch (s_update.state) {
        case UI_KIOSK_UPDATE_FETCHING:
            snprintf(line, cap, text(StrId::UpdateFetchingFmt), (unsigned)s_update.percent);
            return line;
        case UI_KIOSK_UPDATE_CHECKING: return text(StrId::UpdateChecking);
        case UI_KIOSK_UPDATE_RESTARTING: return text(StrId::UpdateRestarting);
        default: return text(StrId::UpdateConnecting);
        }
    }

    static const char *why() noexcept
    {
        switch (s_update.why) {
        case UI_KIOSK_UPDATE_WHY_NETWORK: return text(StrId::UpdateWhyNetwork);
        case UI_KIOSK_UPDATE_WHY_DIGEST: return text(StrId::UpdateWhyDigest);
        case UI_KIOSK_UPDATE_WHY_REFUSED: return text(StrId::UpdateWhyRefused);
        case UI_KIOSK_UPDATE_WHY_TOO_BIG: return text(StrId::UpdateWhyTooBig);
        default: return text(StrId::UpdateWhyOther);
        }
    }
};

ScanScreen s_scan;
MenuScreen s_menu;
EnrolScreen s_enrol;
CaptureScreen s_capture;
PeopleScreen s_people;
SettingsScreen s_settings;
WifiScreen s_wifi;
DeviceScreen s_device;
UpdateScreen s_update_screen;

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

void wifi_ask_scan() noexcept
{
    portENTER_CRITICAL(&s_wifi_lock);
    s_wifi_desk.scan_wanted = true;
    portEXIT_CRITICAL(&s_wifi_lock);
}

bool wifi_take_scan() noexcept
{
    portENTER_CRITICAL(&s_wifi_lock);
    const bool wanted = s_wifi_desk.scan_wanted;
    s_wifi_desk.scan_wanted = false;
    portEXIT_CRITICAL(&s_wifi_lock);
    return wanted;
}

void wifi_stage_networks(const ui_kiosk_ap_t *found, int count) noexcept
{
    const int kept = found == nullptr || count < 0 ? 0 : (count < UI_KIOSK_WIFI_ROWS ? count : UI_KIOSK_WIFI_ROWS);
    portENTER_CRITICAL(&s_wifi_lock);
    // A sweep that heard nothing while the last one heard plenty is a busy radio, not an empty room.
    if (kept > 0 || !s_wifi_desk.swept) {
        s_wifi_desk.heard.count = kept;
        for (int i = 0; i < kept; ++i) {
            s_wifi_desk.heard.row[i] = found[i];
        }
    }
    s_wifi_desk.swept = true;
    ++s_wifi_desk.sweep_serial;
    portEXIT_CRITICAL(&s_wifi_lock);
}

void wifi_ask_join(const JoinRequest &join) noexcept
{
    portENTER_CRITICAL(&s_wifi_lock);
    s_wifi_desk.join = join;
    s_wifi_desk.join_waiting = true;
    portEXIT_CRITICAL(&s_wifi_lock);
}

bool wifi_take_join(JoinRequest *out) noexcept
{
    portENTER_CRITICAL(&s_wifi_lock);
    const bool waiting = s_wifi_desk.join_waiting;
    if (waiting) {
        *out = s_wifi_desk.join;
        s_wifi_desk.join_waiting = false;
    }
    portEXIT_CRITICAL(&s_wifi_lock);
    return waiting;
}

void wifi_stage_joined(ui_kiosk_wifi_result_t result) noexcept
{
    portENTER_CRITICAL(&s_wifi_lock);
    s_wifi_desk.joined = result;
    ++s_wifi_desk.joined_serial;
    portEXIT_CRITICAL(&s_wifi_lock);
}

void wifi_ask_info(const char *ssid) noexcept
{
    portENTER_CRITICAL(&s_wifi_lock);
    strlcpy(s_wifi_desk.info_ssid, ssid, sizeof(s_wifi_desk.info_ssid));
    s_wifi_desk.info_wanted = true;
    portEXIT_CRITICAL(&s_wifi_lock);
}

bool wifi_take_info_request(char *ssid, size_t cap) noexcept
{
    portENTER_CRITICAL(&s_wifi_lock);
    const bool wanted = s_wifi_desk.info_wanted;
    if (wanted) {
        strlcpy(ssid, s_wifi_desk.info_ssid, cap);
        s_wifi_desk.info_wanted = false;
    }
    portEXIT_CRITICAL(&s_wifi_lock);
    return wanted;
}

void wifi_stage_info(const ui_kiosk_wifi_info_t &info) noexcept
{
    portENTER_CRITICAL(&s_wifi_lock);
    s_wifi_desk.info = info;
    ++s_wifi_desk.info_serial;
    portEXIT_CRITICAL(&s_wifi_lock);
}

void wifi_ask_saved() noexcept
{
    portENTER_CRITICAL(&s_wifi_lock);
    s_wifi_desk.saved_wanted = true;
    portEXIT_CRITICAL(&s_wifi_lock);
}

bool wifi_take_saved_request() noexcept
{
    portENTER_CRITICAL(&s_wifi_lock);
    const bool wanted = s_wifi_desk.saved_wanted;
    s_wifi_desk.saved_wanted = false;
    portEXIT_CRITICAL(&s_wifi_lock);
    return wanted;
}

void wifi_stage_saved(const char (*names)[UI_KIOSK_SSID_CAP], int count) noexcept
{
    const int kept = count < 0 ? 0 : (count < UI_KIOSK_WIFI_SAVED_ROWS ? count : UI_KIOSK_WIFI_SAVED_ROWS);
    portENTER_CRITICAL(&s_wifi_lock);
    s_wifi_desk.saved_count = kept;
    for (int i = 0; i < kept; ++i) {
        strlcpy(s_wifi_desk.saved[i], names[i], sizeof(s_wifi_desk.saved[i]));
    }
    ++s_wifi_desk.saved_serial;
    portEXIT_CRITICAL(&s_wifi_lock);
}

void wifi_ask_forget(const char *ssid) noexcept
{
    portENTER_CRITICAL(&s_wifi_lock);
    strlcpy(s_wifi_desk.forget_ssid, ssid, sizeof(s_wifi_desk.forget_ssid));
    s_wifi_desk.forget_waiting = true;
    portEXIT_CRITICAL(&s_wifi_lock);
}

bool wifi_take_forget(char *ssid, size_t cap) noexcept
{
    portENTER_CRITICAL(&s_wifi_lock);
    const bool waiting = s_wifi_desk.forget_waiting;
    if (waiting) {
        strlcpy(ssid, s_wifi_desk.forget_ssid, cap);
        s_wifi_desk.forget_waiting = false;
    }
    portEXIT_CRITICAL(&s_wifi_lock);
    return waiting;
}

void wifi_stage_forgotten(bool forgotten) noexcept
{
    portENTER_CRITICAL(&s_wifi_lock);
    s_wifi_desk.forgotten = forgotten;
    ++s_wifi_desk.forgotten_serial;
    portEXIT_CRITICAL(&s_wifi_lock);
}

EnrolRequest &enrol_request() noexcept
{
    return s_request;
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

Update &update() noexcept
{
    return s_update;
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

bool &recognition() noexcept
{
    return s_recognition;
}

Pending &pending() noexcept
{
    return s_pending;
}


void enrol_kept() noexcept
{
    if (enrol_wanted()) {
        s_capture.kept_one();
    }
}

void enrol_refused() noexcept
{
    if (enrol_wanted()) {
        s_capture.refused_one();
    }
}

bool enrol_complete() noexcept
{
    return s_capture.done();
}

bool enrol_wanted() noexcept
{
    return manager().at() == ScreenId::Capture && s_capture.live();
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

Screen *update_screen() noexcept
{
    return &s_update_screen;
}

}  // namespace ui
