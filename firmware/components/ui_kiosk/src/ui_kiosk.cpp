#include "ui_kiosk.h"

#include <atomic>
#include <new>
#include <string.h>
#include <time.h>

#include "canvas.hpp"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "screens.hpp"

namespace {

const char *TAG = "ui_kiosk";

constexpr int kSlots = 2;
alignas(ui::Canvas) uint8_t s_canvas_store[2][sizeof(ui::Canvas)];
constexpr uint32_t kVerdictShift = 32;
// A line stays up this long, and the same line will not come back inside the
// quiet window: a face nobody enrolled would otherwise strobe it forever.
constexpr int64_t kShowMs = 2500;
constexpr int64_t kQuietMs = 6000;
constexpr int64_t kClockPollMs = 1000;

constexpr uint16_t kWhite = 0xFFFF;
constexpr uint16_t kMint = 0x27EC;
constexpr uint16_t kAmber = 0xFD20;
constexpr uint16_t kShadow = 0x0000;

constexpr uint16_t wire(uint16_t rgb565)
{
    return (uint16_t)((rgb565 >> 8) | (rgb565 << 8));
}

// One map per slot: cam_task reads the published one for a whole frame while
// ui_task paints the other (KEHOACH 4.5.5h).
ui::Canvas *s_canvas[kSlots];
drv_lcd_overlay_t s_slot[kSlots];
std::atomic<const drv_lcd_overlay_t *> s_shown{ nullptr };
int s_next;
uint32_t s_serial;
bool s_ready;
bool s_dirty = true;

ui::Sight s_seen;
std::atomic<uint64_t> s_verdict{ 0 };
char s_name[STORAGE_NAME_CAP];
uint64_t s_verdict_taken;
uint64_t s_line_showing;
int64_t s_clear_in_ms;
int64_t s_quiet_in_ms;
std::atomic<int32_t> s_touch{ -1 };
int64_t s_clock_poll_ms;
int64_t s_minute_shown = -1;

// The whole panel is one map, but only the rectangle a screen touched is worth
// sending: the rest is zero and would cost a scan of 153 KB every frame.
void publish(const ui::Canvas &from)
{
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
        mask->ink_rgb565 = wire(kWhite);
        mask->edge_rgb565 = wire(kShadow);
        mask->accent_rgb565 = wire(kMint);
        mask->warn_rgb565 = wire(kAmber);
    }
    target->masks = (uint8_t)kept;
    target->opaque = ui::manager().current()->opaque();
    target->serial = ++s_serial;
    s_next = (s_next + 1) % kSlots;
    s_shown.store(target, std::memory_order_release);
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

void take_verdict(int64_t dt_ms)
{
    s_clear_in_ms -= s_clear_in_ms > 0 ? dt_ms : 0;
    s_quiet_in_ms -= s_quiet_in_ms > 0 ? dt_ms : 0;
    const uint64_t packed = s_verdict.load(std::memory_order_acquire);
    if (packed != s_verdict_taken) {
        s_verdict_taken = packed;
        const app_ui_verdict_t verdict = static_cast<app_ui_verdict_t>(packed >> kVerdictShift);
        // The quiet window keeps a refusal from strobing; a second clock-in for
        // the same person is news and has to show.
        const bool quiet = packed == s_line_showing && s_quiet_in_ms > 0 &&
                           verdict != APP_UI_GRANTED;
        if (verdict > APP_UI_SCANNING && !quiet) {
            s_line_showing = packed;
            s_clear_in_ms = kShowMs;
            s_quiet_in_ms = kQuietMs;
            s_seen.verdict = verdict;
            s_seen.employee_id = static_cast<uint32_t>(packed);
            strlcpy(s_seen.name, s_name, sizeof(s_seen.name));
            s_dirty = true;
        }
        s_seen.verifying = verdict == APP_UI_SCANNING;
    }
    if (s_clear_in_ms == 0 && s_seen.verdict > APP_UI_SCANNING) {
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
    memset(s_slot, 0, sizeof(s_slot));
    memset(&s_seen, 0, sizeof(s_seen));
    s_ready = true;
    ui_kiosk_tick(0);
    ESP_LOGI(TAG, "screens up on a %dx%d map", APP_LCD_H_RES, APP_LCD_V_RES);
    return ESP_OK;
}

void ui_kiosk_on_faces(const float *boxes, int count, int frame_width, int frame_height,
                       int face_min_px)
{
    // The tracked face leads the list (KEHOACH 4.5.5d), and the guide is about
    // the person being served, not about whoever else is in shot.
    const bool face = count > 0;
    ui::Place place = ui::Place::Nothing;
    if (face) {
        const float w = boxes[2] - boxes[0];
        const float h = boxes[3] - boxes[1];
        const bool close_enough = (w > h ? w : h) >= (float)face_min_px;
        int16_t panel[4] = { 0, 0, 0, 0 };
        place = drv_lcd_frame_to_panel(frame_width, frame_height, boxes, panel)
                    ? ui::place_of(panel, close_enough)
                    : ui::Place::Outside;
    }
    if (face != s_seen.face || place != s_seen.place) {
        s_seen.face = face;
        s_seen.place = place;
        s_dirty = true;
    }
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
    take_verdict(dt_ms);
    s_dirty = ui::manager().current()->tick(dt_ms, s_seen) || s_dirty;
    if (!s_dirty) {
        return;
    }
    s_dirty = false;
    ui::Canvas &canvas = *s_canvas[s_next];
    canvas.clear();
    ui::manager().current()->paint(canvas, s_seen);
    publish(canvas);
}

bool ui_kiosk_take_enrol(uint32_t *employee_id, uint16_t *template_idx, char *name, size_t cap)
{
    if (!s_ready || !ui::enrol_request().waiting) {
        return false;
    }
    *employee_id = ui::enrol_request().employee_id;
    *template_idx = ui::enrol_request().template_idx;
    strlcpy(name, ui::enrol_request().name, cap);
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

bool ui_kiosk_enrolling(void)
{
    return s_ready && ui::manager().at() == ui::ScreenId::Capture;
}

void ui_kiosk_enrol_kept(void)
{
    if (s_ready) {
        ui::enrol_kept();
        s_dirty = true;
    }
}

const drv_lcd_overlay_t *ui_kiosk_overlay(void)
{
    return s_shown.load(std::memory_order_acquire);
}
