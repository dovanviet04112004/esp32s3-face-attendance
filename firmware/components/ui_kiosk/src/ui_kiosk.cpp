#include "ui_kiosk.h"

#include <atomic>
#include <new>
#include <string.h>
#include <time.h>

#include "canvas.hpp"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "screens.hpp"
#include "strings.hpp"
#include "theme.hpp"

namespace {

const char *TAG = "ui_kiosk";

constexpr int kSlots = 2;
alignas(ui::Canvas) uint8_t s_canvas_store[2][sizeof(ui::Canvas)];
// How long a card survives with nobody behind it; the next person being served
// takes it down sooner, so it does not have to be generous.
constexpr int64_t kShowMs = 1500;
// A prompt nobody can finish reading is worse than the wrong prompt: svc_vision
// changes its mind per step, which is faster than an eye (KEHOACH 4.5.5h.1).
constexpr int64_t kStageDwellMs = 700;
constexpr int64_t kClockPollMs = 1000;
// A failure and the note after a new build both stand this long (KEHOACH 7.7).
constexpr int64_t kUpdateHoldMs = 10000;

// One map per slot: cam_task reads the published one for a whole frame while
// ui_task paints the other (KEHOACH 4.5.5h).
ui::Canvas *s_canvas[kSlots];
drv_lcd_overlay_t s_slot[kSlots];
std::atomic<const drv_lcd_overlay_t *> s_shown{ nullptr };
std::atomic<int> s_held{ -1 };
std::atomic<bool> s_covers{ false };
int s_next;
uint32_t s_serial;
uint32_t s_sent;                          // serial of the last map published
std::atomic<uint32_t> s_on_glass{ 0 };    // serial cam_task last put on the panel
bool s_ready;
bool s_dirty = true;
SemaphoreHandle_t s_published;

ui::Sight s_seen;
ui_kiosk_stage_t s_wanted = UI_KIOSK_STAGE_NO_FACE;
int64_t s_stage_held_ms;
// One writer, one reader, and the verdict is wider than a word (KEHOACH 5.3).
portMUX_TYPE s_offer_lock = portMUX_INITIALIZER_UNLOCKED;
ui_kiosk_verdict_t s_offer;
uint32_t s_offer_serial;
uint32_t s_taken_serial;
int64_t s_clear_in_ms;
std::atomic<int32_t> s_touch{ -1 };
int64_t s_clock_poll_ms;
int64_t s_minute_shown = -1;
// ota_task and attend_task write the update, ui_task alone turns it into a screen.
portMUX_TYPE s_update_lock = portMUX_INITIALIZER_UNLOCKED;
ui::Update s_update_offer;
uint32_t s_update_serial;
uint32_t s_update_taken;
std::atomic<uint8_t> s_update_state{ UI_KIOSK_UPDATE_NONE };
int64_t s_update_left_ms;

bool covering(ui_kiosk_update_t state)
{
    return state != UI_KIOSK_UPDATE_NONE && state != UI_KIOSK_UPDATE_DONE;
}

// The whole panel is one map, but only the rectangle a screen touched is worth
// sending: the rest is zero and would cost a scan of 153 KB every frame.
void publish(ui::Canvas &from)
{
    const bool opaque = ui::manager().current()->opaque();
    // Every painted cell goes out: sending only the difference from the map on
    // the glass draws a screen in pieces the moment that assumption slips.
    from.offer_painted();
    drv_lcd_overlay_t *target = &s_slot[s_next];
    memset(target, 0, sizeof(*target));
    ui::Canvas::Region region[DRV_LCD_OVERLAY_MASKS];
    const int kept = from.regions(region, DRV_LCD_OVERLAY_MASKS);
    for (int i = 0; i < kept; ++i) {
        drv_lcd_mask_t *mask = &target->mask[i];
        mask->x = region[i].x;
        mask->y = region[i].y;
        mask->w = region[i].w;
        mask->h = region[i].h;
        mask->stride = APP_LCD_H_RES;
        mask->cover = from.cells() + (size_t)region[i].y * APP_LCD_H_RES + region[i].x;
        mask->palette = ui::theme::palette();
    }
    target->masks = (uint8_t)kept;
    target->opaque = opaque;
    s_covers.store(target->opaque, std::memory_order_release);
    target->serial = ++s_serial;
    s_shown.store(target, std::memory_order_release);
    s_sent = target->serial;
    xSemaphoreGive(s_published);
}

// Every screen paints the clock, and a repaint needs a reason, so the minute
// rolling over is one.
void mind_the_clock(int64_t dt_ms)
{
    s_clock_poll_ms += dt_ms;
    if (s_clock_poll_ms < kClockPollMs) {
        return;
    }
    s_clock_poll_ms = 0;
    const int64_t minute = (int64_t)time(nullptr) / 60;
    if (minute != s_minute_shown) {
        s_minute_shown = minute;
        s_dirty = true;
    }
}

void settle_stage(int64_t dt_ms)
{
    s_stage_held_ms += dt_ms;
    if (s_wanted == s_seen.stage) {
        return;
    }
    // Losing the face is news at once; every other change waits its turn.
    if (s_wanted != UI_KIOSK_STAGE_NO_FACE && s_stage_held_ms < kStageDwellMs) {
        return;
    }
    s_seen.stage = s_wanted;
    s_stage_held_ms = 0;
    s_dirty = true;
}

void take_verdict(int64_t dt_ms)
{
    s_clear_in_ms -= s_clear_in_ms > 0 ? dt_ms : 0;
    portENTER_CRITICAL(&s_offer_lock);
    const uint32_t serial = s_offer_serial;
    const ui_kiosk_verdict_t offer = s_offer;
    portEXIT_CRITICAL(&s_offer_lock);
    if (serial != s_taken_serial) {
        s_taken_serial = serial;
        if (offer.verdict == APP_UI_ALREADY) {
            // Nothing new to say, only which face the quiet guide belongs to (KEHOACH 4.5.5f).
            s_seen.verdict_track = offer.track;
            if (s_seen.verdict != APP_UI_GRANTED) {
                s_seen.verdict = APP_UI_ALREADY;
                s_clear_in_ms = kShowMs;
            }
            s_dirty = true;
        } else if (offer.verdict > APP_UI_SCANNING) {
            // The same verdict about the same face is the same news, so it is held
            // rather than blanked and flashed back (KEHOACH 4.5.5h.1).
            const bool holding =
                s_seen.verdict == offer.verdict && s_seen.verdict_track == offer.track;
            s_clear_in_ms = kShowMs;
            if (!holding) {
                s_seen.verdict = offer.verdict;
                s_seen.verdict_track = offer.track;
                s_seen.employee_id = offer.employee_id;
                strlcpy(s_seen.name, offer.name, sizeof(s_seen.name));
                s_dirty = true;
            }
        } else if (offer.verdict == APP_UI_SCANNING) {
            // The machine has taken up somebody new, and nothing said so far is theirs.
            s_clear_in_ms = -1;
            s_seen.verdict = APP_UI_IDLE;
            s_seen.verdict_track = 0;
            s_dirty = true;
        }
    }
    // The countdown steps by whole ticks, so it can pass zero without landing on it.
    if (s_clear_in_ms <= 0 && s_seen.verdict > APP_UI_SCANNING) {
        s_clear_in_ms = -1;
        s_seen.verdict = APP_UI_IDLE;
        s_dirty = true;
    }
}

// The Update screen takes the panel from whatever is up and gives it back to the scan screen.
void take_update(int64_t dt_ms)
{
    portENTER_CRITICAL(&s_update_lock);
    const uint32_t serial = s_update_serial;
    const ui::Update offer = s_update_offer;
    portEXIT_CRITICAL(&s_update_lock);
    ui::Update &held = ui::update();
    if (serial != s_update_taken) {
        s_update_taken = serial;
        const bool held_open = held.capture_dropped && covering(held.state);
        held = offer;
        held.capture_dropped = held_open;
        s_update_left_ms = kUpdateHoldMs;
        s_dirty = true;
    }
    if (held.state == UI_KIOSK_UPDATE_FAILED || held.state == UI_KIOSK_UPDATE_DONE) {
        s_update_left_ms -= dt_ms;
        const uint8_t left_s = (uint8_t)((s_update_left_ms + 999) / 1000);
        if (s_update_left_ms <= 0) {
            held.state = UI_KIOSK_UPDATE_NONE;
            s_dirty = true;
        } else if (left_s != held.resume_s) {
            held.resume_s = left_s;
            s_dirty = true;
        }
    }
    s_update_state.store((uint8_t)held.state, std::memory_order_release);
    const bool covers = covering(held.state);
    const ui::ScreenId at = ui::manager().at();
    if (covers && at != ui::ScreenId::Update) {
        held.capture_dropped = at == ui::ScreenId::Capture;
        ui::manager().go(ui::ScreenId::Update);
        s_dirty = true;
    } else if (!covers && at == ui::ScreenId::Update) {
        held.capture_dropped = false;
        ui::manager().go(ui::ScreenId::Scan);
        s_dirty = true;
    }
}

}  // namespace

esp_err_t ui_kiosk_init(void)
{
    if (s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    s_published = xSemaphoreCreateBinary();
    if (s_published == nullptr) {
        return ESP_ERR_NO_MEM;
    }
    for (int i = 0; i < kSlots; ++i) {
        uint8_t *cells = static_cast<uint8_t *>(
            heap_caps_malloc((size_t)APP_LCD_H_RES * APP_LCD_V_RES, MALLOC_CAP_SPIRAM));
        if (cells == nullptr) {
            return ESP_ERR_NO_MEM;
        }
        s_canvas[i] = new (s_canvas_store[i]) ui::Canvas(cells, APP_LCD_H_RES, APP_LCD_V_RES);
        s_canvas[i]->wipe();
    }
    ui::manager().attach(ui::ScreenId::Scan, ui::scan_screen());
    ui::manager().attach(ui::ScreenId::Menu, ui::menu_screen());
    ui::manager().attach(ui::ScreenId::Enrol, ui::enrol_screen());
    ui::manager().attach(ui::ScreenId::Capture, ui::capture_screen());
    ui::manager().attach(ui::ScreenId::People, ui::people_screen());
    ui::manager().attach(ui::ScreenId::Settings, ui::settings_screen());
    ui::manager().attach(ui::ScreenId::Wifi, ui::wifi_screen());
    ui::manager().attach(ui::ScreenId::Device, ui::device_screen());
    ui::manager().attach(ui::ScreenId::Person, ui::person_screen());
    ui::manager().attach(ui::ScreenId::Update, ui::update_screen());
    memset(s_slot, 0, sizeof(s_slot));
    memset(&s_seen, 0, sizeof(s_seen));
    s_ready = true;
    ui_kiosk_tick(0);
    ESP_LOGI(TAG, "screens up on a %dx%d map", APP_LCD_H_RES, APP_LCD_V_RES);
    return ESP_OK;
}

void ui_kiosk_on_faces(const float *boxes, int count, int frame_width, int frame_height,
                       float yaw, uint32_t track)
{
    // The tracked face leads the list (KEHOACH 4.5.5d), and the guide is about
    // the person being served, not about whoever else is in shot.
    (void)frame_width;
    (void)frame_height;
    (void)boxes;
    const bool face = count > 0;
    s_seen.track = track;
    // Capture reads the turn every tick, so it lands whether or not the box moved.
    s_seen.yaw = face ? yaw : 0.0f;
    ++s_seen.samples;
    if (face != s_seen.face) {
        s_seen.face = face;
        s_dirty = true;
    }
}

void ui_kiosk_on_stage(ui_kiosk_stage_t stage)
{
    s_wanted = stage;
}

void ui_kiosk_on_verdict(const ui_kiosk_verdict_t *verdict)
{
    if (verdict == nullptr) {
        return;
    }
    portENTER_CRITICAL(&s_offer_lock);
    s_offer = *verdict;
    ++s_offer_serial;
    portEXIT_CRITICAL(&s_offer_lock);
}

void ui_kiosk_on_touch(bool down, int x, int y)
{
    if (!s_ready) {
        return;
    }
    s_touch.store(down ? ((x & 0xFFFF) << 12) | (y & 0xFFF) : -1, std::memory_order_release);
}

void ui_kiosk_tick(uint32_t dt_ms)
{
    if (!s_ready) {
        return;
    }
    static int32_t was = -1;
    const int32_t now = s_touch.load(std::memory_order_acquire);
    if (now != was) {
        const int32_t report = now >= 0 ? now : was;
        const int x = report >= 0 ? (report >> 12) & 0xFFFF : 0;
        const int y = report >= 0 ? report & 0xFFF : 0;
        was = now;
        s_dirty = ui::manager().current()->on_touch(x, y, now >= 0) || s_dirty;
    }
    mind_the_clock(dt_ms);
    settle_stage(dt_ms);
    take_verdict(dt_ms);
    take_update(dt_ms);
    s_dirty = ui::manager().current()->tick(dt_ms, s_seen) || s_dirty;
    if (!s_dirty) {
        return;
    }
    // Publishing again over a map the panel never took would drop whatever that
    // map alone carried, because the next one is only a delta against it.
    if (s_sent != 0 && s_on_glass.load(std::memory_order_acquire) != s_sent) {
        return;
    }
    const drv_lcd_overlay_t *glass = s_shown.load(std::memory_order_acquire);
    const int reading = s_held.load(std::memory_order_acquire);
    int free_slot = -1;
    for (int i = 0; i < kSlots; ++i) {
        if (&s_slot[i] != glass && i != reading) {
            free_slot = i;
            break;
        }
    }
    // Painting over the slot on the glass or the one being read is what makes a
    // frame carry half of two overlays, so a full house waits a tick.
    if (free_slot < 0) {
        return;
    }
    s_dirty = false;
    s_next = free_slot;
    ui::Canvas &canvas = *s_canvas[s_next];
    canvas.clear();
    ui::manager().current()->paint(canvas, s_seen);
    publish(canvas);
}

bool ui_kiosk_take_enrol(uint32_t *employee_id, uint16_t *template_idx, char *name, size_t cap,
                         float *yaw_min, float *yaw_max)
{
    if (!s_ready || !ui::enrol_request().waiting) {
        return false;
    }
    *employee_id = ui::enrol_request().employee_id;
    *template_idx = ui::enrol_request().template_idx;
    strlcpy(name, ui::enrol_request().name, cap);
    *yaw_min = ui::enrol_request().yaw_min;
    *yaw_max = ui::enrol_request().yaw_max;
    ui::enrol_request().waiting = false;
    return true;
}

bool ui_kiosk_take_people_request(void)
{
    if (!s_ready || !ui::people().wanted) {
        return false;
    }
    ui::people().wanted = false;
    return true;
}

void ui_kiosk_refresh_people(void)
{
    if (s_ready) {
        ui::people().wanted = true;
    }
}

bool ui_kiosk_take_remove(uint32_t *employee_id)
{
    if (!s_ready || employee_id == nullptr || !ui::remove_request().waiting) {
        return false;
    }
    *employee_id = ui::remove_request().employee_id;
    ui::remove_request().waiting = false;
    return true;
}

bool ui_kiosk_take_retake(uint32_t *employee_id, char *name, size_t cap)
{
    if (!s_ready || employee_id == nullptr || name == nullptr || !ui::person_pick().retake_waiting) {
        return false;
    }
    *employee_id = ui::person_pick().employee_id;
    strlcpy(name, ui::person_pick().name, cap);
    ui::person_pick().retake_waiting = false;
    return true;
}

void ui_kiosk_set_asks_room(bool room)
{
    if (!s_ready) {
        return;
    }
    if (ui::person_pick().room != room) {
        ui::person_pick().room = room;
        s_dirty = true;
    }
}

void ui_kiosk_set_people(const ui_kiosk_person_t *people, int count)
{
    if (!s_ready) {
        return;
    }
    ui::people().count = count < UI_KIOSK_PEOPLE_ROWS ? count : UI_KIOSK_PEOPLE_ROWS;
    memcpy(ui::people().row, people, sizeof(ui_kiosk_person_t) * ui::people().count);
    s_dirty = true;
}

bool ui_kiosk_take_wifi_scan(void)
{
    if (!s_ready || !ui::networks().wanted) {
        return false;
    }
    ui::networks().wanted = false;
    return true;
}

void ui_kiosk_set_networks(const ui_kiosk_ap_t *found, int count)
{
    if (!s_ready) {
        return;
    }
    const int kept = count < UI_KIOSK_WIFI_ROWS ? count : UI_KIOSK_WIFI_ROWS;
    // A sweep that heard nothing while the last one heard plenty is the radio
    // being busy, not a room that emptied, so the list it replaces stands.
    if (kept > 0 && found != nullptr) {
        ui::networks().count = kept;
        memcpy(ui::networks().row, found, sizeof(ui_kiosk_ap_t) * (size_t)kept);
    } else if (!ui::networks().fresh) {
        ui::networks().count = 0;
    }
    ui::networks().fresh = true;
    s_dirty = true;
}

bool ui_kiosk_take_wifi_join(char *ssid, size_t ssid_cap, char *pass, size_t pass_cap,
                             bool *stored)
{
    if (!s_ready || ssid == nullptr || pass == nullptr || !ui::join_request().waiting) {
        return false;
    }
    strlcpy(ssid, ui::join_request().ssid, ssid_cap);
    strlcpy(pass, ui::join_request().pass, pass_cap);
    if (stored != nullptr) {
        *stored = ui::join_request().stored;
    }
    ui::join_request().waiting = false;
    return true;
}

void ui_kiosk_wifi_joined(esp_err_t result)
{
    if (!s_ready) {
        return;
    }
    ui::join_request().result = result;
    ui::join_request().answered = true;
    s_dirty = true;
}

bool ui_kiosk_enrolling(void)
{
    return s_ready && ui::manager().at() == ui::ScreenId::Capture;
}

bool ui_kiosk_enrol_complete(void)
{
    return s_ready && ui::enrol_complete();
}

void ui_kiosk_enrol_kept(void)
{
    if (s_ready) {
        ui::enrol_kept();
        s_dirty = true;
    }
}

void ui_kiosk_enrol_refused(void)
{
    if (s_ready) {
        ui::enrol_refused();
        s_dirty = true;
    }
}

void ui_kiosk_set_facts(const ui_kiosk_fact_t *facts, int count)
{
    if (!s_ready || facts == NULL) {
        return;
    }
    const int kept = count < UI_KIOSK_FACTS ? count : UI_KIOSK_FACTS;
    ui::facts().count = kept > 0 ? kept : 0;
    if (kept > 0) {
        memcpy(ui::facts().row, facts, sizeof(ui_kiosk_fact_t) * (size_t)kept);
    }
    s_dirty = true;
}

void ui_kiosk_set_net(const ui_kiosk_net_t *net)
{
    if (!s_ready || net == NULL) {
        return;
    }
    if (memcmp(&ui::net(), net, sizeof(*net)) != 0) {
        ui::net() = *net;
        s_dirty = true;
    }
}

void ui_kiosk_set_ticket(ui_kiosk_ticket_t state, const char *device_id, const char *claim)
{
    if (!s_ready) {
        return;
    }
    ui::Ticket &held = ui::ticket();
    held.state = state;
    if (device_id != nullptr) {
        strlcpy(held.device_id, device_id, sizeof(held.device_id));
    }
    if (claim != nullptr) {
        strlcpy(held.claim, claim, sizeof(held.claim));
    }
    s_dirty = true;
}

void ui_kiosk_set_update(ui_kiosk_update_t state, uint8_t percent, const char *version,
                         ui_kiosk_update_why_t why)
{
    if (!s_ready) {
        return;
    }
    portENTER_CRITICAL(&s_update_lock);
    const bool same = s_update_offer.state == state && s_update_offer.percent == percent &&
                      s_update_offer.why == why &&
                      (version == nullptr || strcmp(s_update_offer.version, version) == 0);
    if (!same) {
        s_update_offer.state = state;
        s_update_offer.percent = percent;
        s_update_offer.why = why;
        if (version != nullptr) {
            strlcpy(s_update_offer.version, version, sizeof(s_update_offer.version));
        }
        ++s_update_serial;
    }
    portEXIT_CRITICAL(&s_update_lock);
    if (covering(state)) {
        s_update_state.store((uint8_t)state, std::memory_order_release);
    }
}

void ui_kiosk_update_progress(ui_kiosk_update_t phase, uint8_t percent)
{
    if (!s_ready) {
        return;
    }
    portENTER_CRITICAL(&s_update_lock);
    const ui_kiosk_update_t held = s_update_offer.state;
    const bool moving = held == UI_KIOSK_UPDATE_CONNECTING || held == UI_KIOSK_UPDATE_FETCHING ||
                        held == UI_KIOSK_UPDATE_CHECKING;
    if (moving && (held != phase || s_update_offer.percent != percent)) {
        s_update_offer.state = phase;
        s_update_offer.percent = percent;
        ++s_update_serial;
    }
    portEXIT_CRITICAL(&s_update_lock);
}

bool ui_kiosk_update_covers(void)
{
    return covering((ui_kiosk_update_t)s_update_state.load(std::memory_order_acquire));
}

void ui_kiosk_set_levels(uint8_t brightness, uint8_t volume)
{
    if (!s_ready) {
        return;
    }
    ui::brightness().percent = brightness;
    ui::volume().percent = volume;
    s_dirty = true;
}

void ui_kiosk_set_language(const char *code)
{
    ui::set_language(ui::language_of(code));
    s_dirty = true;
}

bool ui_kiosk_take_language(const char **code)
{
    if (!s_ready || code == NULL || !ui::language_changed()) {
        return false;
    }
    *code = ui::language_code(ui::language());
    ui::language_changed() = false;
    return true;
}

bool ui_kiosk_take_level(ui_kiosk_level_t *which, uint8_t *percent, bool *settled)
{
    if (!s_ready || which == NULL || percent == NULL || settled == NULL) {
        return false;
    }
    ui::Level *level = NULL;
    if (ui::brightness().changed) {
        level = &ui::brightness();
        *which = UI_KIOSK_LEVEL_BRIGHTNESS;
    } else if (ui::volume().changed) {
        level = &ui::volume();
        *which = UI_KIOSK_LEVEL_VOLUME;
    } else {
        return false;
    }
    *percent = level->percent;
    *settled = level->settled;
    level->changed = false;
    level->settled = false;
    return true;
}

void ui_kiosk_set_pending(const ui_kiosk_pending_t *rows, int count, int first, int total)
{
    if (!s_ready) {
        return;
    }
    const int kept = count < UI_KIOSK_PENDING_ROWS ? count : UI_KIOSK_PENDING_ROWS;
    ui::pending().count = kept > 0 ? kept : 0;
    ui::pending().first = first > 0 ? first : 0;
    ui::pending().total = total > 0 ? total : 0;
    if (rows != NULL && kept > 0) {
        memcpy(ui::pending().row, rows, sizeof(ui_kiosk_pending_t) * (size_t)kept);
    }
    s_dirty = true;
}

int ui_kiosk_pending_first(void)
{
    return s_ready ? ui::pending().asked : 0;
}

bool ui_kiosk_take_pending_request(void)
{
    if (!s_ready || !ui::pending().wanted) {
        return false;
    }
    ui::pending().wanted = false;
    return true;
}

void ui_kiosk_shown(uint32_t serial)
{
    s_on_glass.store(serial, std::memory_order_release);
}

bool ui_kiosk_take_vision_reset(bool *stuck)
{
    if (!s_ready || ui::vision_reset() == ui::Restart::No) {
        return false;
    }
    if (stuck != nullptr) {
        *stuck = ui::vision_reset() == ui::Restart::Stuck;
    }
    ui::vision_reset() = ui::Restart::No;
    // The screens hold nothing of what the last look decided, so the first
    // fresh sight is what the person in front of the kiosk is judged on.
    s_seen.face = false;
    s_seen.stage = UI_KIOSK_STAGE_NO_FACE;
    s_seen.verdict = APP_UI_IDLE;
    s_seen.verdict_track = 0;
    s_wanted = UI_KIOSK_STAGE_NO_FACE;
    s_dirty = true;
    return true;
}

uint16_t ui_kiosk_ground_rgb565(void)
{
    return ui::theme::palette()[DRV_LCD_GROUND];
}

const drv_lcd_overlay_t *ui_kiosk_overlay(void)
{
    return s_shown.load(std::memory_order_acquire);
}

bool ui_kiosk_screen_covers(void)
{
    return s_covers.load(std::memory_order_acquire);
}

const drv_lcd_overlay_t *ui_kiosk_hold(void)
{
    const drv_lcd_overlay_t *glass = s_shown.load(std::memory_order_acquire);
    for (int i = 0; i < kSlots; ++i) {
        if (glass == &s_slot[i]) {
            s_held.store(i, std::memory_order_release);
            return glass;
        }
    }
    s_held.store(-1, std::memory_order_release);
    return glass;
}

void ui_kiosk_release(void)
{
    s_held.store(-1, std::memory_order_release);
}

void ui_kiosk_guide(int16_t out[4])
{
    ui::guide_box(out);
}

bool ui_kiosk_wait_publish(uint32_t timeout_ms)
{
    if (s_published == nullptr) {
        vTaskDelay(pdMS_TO_TICKS(timeout_ms));
        return false;
    }
    return xSemaphoreTake(s_published, pdMS_TO_TICKS(timeout_ms)) == pdTRUE;
}
