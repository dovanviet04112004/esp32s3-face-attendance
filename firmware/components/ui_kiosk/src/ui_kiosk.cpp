#include "ui_kiosk.h"

#include <atomic>
#include <new>
#include <string.h>
#include <time.h>

#include "canvas.hpp"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "screens.hpp"
#include "theme.hpp"

namespace {

const char *TAG = "ui_kiosk";

constexpr int kSlots = 2;
alignas(ui::Canvas) uint8_t s_canvas_store[2][sizeof(ui::Canvas)];
constexpr uint32_t kVerdictShift = 32;
// How long a card survives with nobody behind it; the next person being served
// takes it down sooner, so it does not have to be generous.
constexpr int64_t kShowMs = 1500;
// A prompt nobody can finish reading is worse than the wrong prompt: svc_vision
// changes its mind per step, which is faster than an eye (KEHOACH 4.5.5h.1).
constexpr int64_t kStageDwellMs = 700;
constexpr int64_t kClockPollMs = 1000;

// One map per slot: cam_task reads the published one for a whole frame while
// ui_task paints the other (KEHOACH 4.5.5h).
ui::Canvas *s_canvas[kSlots];
drv_lcd_overlay_t s_slot[kSlots];
std::atomic<const drv_lcd_overlay_t *> s_shown{ nullptr };
std::atomic<int> s_held{ -1 };
std::atomic<bool> s_covers{ false };
int s_next;
int s_glass = -1;                         // slot the panel is showing, -1 for none
bool s_glass_opaque;
uint32_t s_serial;
bool s_ready;
bool s_dirty = true;

ui::Sight s_seen;
ui_kiosk_stage_t s_wanted = UI_KIOSK_STAGE_NO_FACE;
int64_t s_stage_held_ms;
std::atomic<uint64_t> s_verdict{ 0 };
char s_name[STORAGE_NAME_CAP];
uint64_t s_verdict_taken;
uint64_t s_line_showing;
int64_t s_clear_in_ms;
std::atomic<int32_t> s_touch{ -1 };
int64_t s_clock_poll_ms;
int64_t s_minute_shown = -1;

// The whole panel is one map, but only the rectangle a screen touched is worth
// sending: the rest is zero and would cost a scan of 153 KB every frame.
void publish(ui::Canvas &from)
{
    const bool opaque = ui::manager().current()->opaque();
    // cam_task repaints the panel from the sensor every frame, so an overlay over
    // video has to carry every painted cell; only drv_lcd_paint owns the glass.
    if (opaque && s_glass_opaque && s_glass >= 0 && s_glass != s_next) {
        from.diff_from(s_canvas[s_glass]->cells());
    } else {
        from.offer_painted();
    }
    drv_lcd_overlay_t *target = &s_slot[s_next];
    memset(target, 0, sizeof(*target));
    ui::Canvas::Region region[DRV_LCD_OVERLAY_MASKS];
    int kept = from.regions(region, DRV_LCD_OVERLAY_MASKS);
    // A full house means regions ran out of room and dropped the rest, which
    // would leave stale pixels; the whole map costs more but says everything.
    if (kept == DRV_LCD_OVERLAY_MASKS) {
        from.offer_painted();
        kept = from.regions(region, DRV_LCD_OVERLAY_MASKS);
    }
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
    s_glass = s_next;
    s_glass_opaque = opaque;
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
    const uint64_t packed = s_verdict.load(std::memory_order_acquire);
    if (packed != s_verdict_taken) {
        s_verdict_taken = packed;
        const app_ui_verdict_t verdict = static_cast<app_ui_verdict_t>(packed >> kVerdictShift);
        if (verdict > APP_UI_SCANNING) {
            // The same refusal arriving again is the same news, so the line is
            // held rather than blanked and flashed back (KEHOACH 4.5.5h).
            const bool holding = packed == s_line_showing && s_seen.verdict == verdict &&
                                 verdict != APP_UI_GRANTED;
            s_clear_in_ms = kShowMs;
            if (!holding) {
                s_line_showing = packed;
                s_seen.verdict = verdict;
                s_seen.employee_id = static_cast<uint32_t>(packed);
                strlcpy(s_seen.name, s_name, sizeof(s_seen.name));
                s_dirty = true;
            }
        } else if (verdict == APP_UI_SCANNING && s_seen.verdict > APP_UI_SCANNING) {
            // The machine has taken up somebody else, so the last person's card
            // must not be what the new one is looking at (KEHOACH 4.5.5h.1).
            s_clear_in_ms = -1;
            s_seen.verdict = APP_UI_SCANNING;
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

}  // namespace

esp_err_t ui_kiosk_init(void)
{
    if (s_ready) {
        return ESP_ERR_INVALID_STATE;
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

void ui_kiosk_on_verdict(app_ui_verdict_t verdict, uint32_t employee_id, const char *name)
{
    // The word below is what makes the screen look at this, so it lands second.
    strlcpy(s_name, name != NULL ? name : "", sizeof(s_name));
    s_verdict.store(((uint64_t)verdict << kVerdictShift) | employee_id,
                    std::memory_order_release);
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
    s_dirty = ui::manager().current()->tick(dt_ms, s_seen) || s_dirty;
    if (!s_dirty) {
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

bool ui_kiosk_take_remove(uint32_t *employee_id)
{
    if (!s_ready || employee_id == nullptr || !ui::remove_request().waiting) {
        return false;
    }
    *employee_id = ui::remove_request().employee_id;
    ui::remove_request().waiting = false;
    return true;
}

void ui_kiosk_set_people(const ui_kiosk_person_t *people, int count)
{
    if (!s_ready) {
        return;
    }
    ui::people().count = count < UI_KIOSK_PEOPLE_ROWS ? count : UI_KIOSK_PEOPLE_ROWS;
    memcpy(ui::people().row, people, sizeof(ui_kiosk_person_t) * ui::people().count);
    ui::people_delivered();
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
    ui::networks().count = kept > 0 ? kept : 0;
    if (found != nullptr && kept > 0) {
        memcpy(ui::networks().row, found, sizeof(ui_kiosk_ap_t) * (size_t)kept);
    }
    ui::networks().fresh = true;
    s_dirty = true;
}

bool ui_kiosk_take_wifi_join(char *ssid, size_t ssid_cap, char *pass, size_t pass_cap)
{
    if (!s_ready || ssid == nullptr || pass == nullptr || !ui::join_request().waiting) {
        return false;
    }
    strlcpy(ssid, ui::join_request().ssid, ssid_cap);
    strlcpy(pass, ui::join_request().pass, pass_cap);
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

void ui_kiosk_set_levels(uint8_t brightness, uint8_t volume)
{
    if (!s_ready) {
        return;
    }
    ui::brightness().percent = brightness;
    ui::volume().percent = volume;
    s_dirty = true;
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

void ui_kiosk_set_pending(const ui_kiosk_pending_t *rows, int count)
{
    if (!s_ready) {
        return;
    }
    const int kept = count < UI_KIOSK_PENDING_ROWS ? count : UI_KIOSK_PENDING_ROWS;
    ui::pending().count = kept > 0 ? kept : 0;
    if (rows != NULL && kept > 0) {
        memcpy(ui::pending().row, rows, sizeof(ui_kiosk_pending_t) * (size_t)kept);
    }
    s_dirty = true;
}

bool ui_kiosk_take_pending_request(void)
{
    if (!s_ready || !ui::pending().wanted) {
        return false;
    }
    ui::pending().wanted = false;
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
