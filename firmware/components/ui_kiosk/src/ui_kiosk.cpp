#include "ui_kiosk.h"

#include <atomic>
#include <string.h>

#include "box_tracker.hpp"
#include "esp_log.h"
#include "esp_timer.h"
#include "overlay.hpp"
#include "storage_format.h"

namespace {

const char *TAG = "ui_kiosk";

constexpr int kSlots = 2;
constexpr int kHistory = 24;
constexpr uint32_t kVerdictShift = 32;
// A line stays up this long, and the same line will not come back inside the
// quiet window: a face nobody enrolled would otherwise strobe it forever.
constexpr int64_t kShowUs = 2500000;
constexpr int64_t kQuietUs = 6000000;

struct Detect {
    float box[DRV_LCD_OVERLAY_BOXES][4];
    int count;
    int width;
    int height;
    int64_t stamp_us;                     // the frame the detector read
};

// How far the face has travelled since each of the last frames drawn, so a box
// that took half a second to compute can be carried forward to now.
struct Travelled {
    int64_t stamp_us;
    int32_t x;
    int32_t y;
};

ui::OverlayBuilder s_builder;
ui::BoxTracker s_tracker;
drv_lcd_overlay_t s_slot[kSlots];
std::atomic<const drv_lcd_overlay_t *> s_shown{ nullptr };
int s_next;
bool s_ready;

Travelled s_history[kHistory];
int s_history_next;
int32_t s_travel_x;
int32_t s_travel_y;

// The preview path is the only writer, so what the other two tasks report
// arrives through one atomic handover each.
Detect s_detect_slot[kSlots];
std::atomic<const Detect *> s_detect{ nullptr };
int s_detect_next;
std::atomic<uint64_t> s_verdict{ 0 };
char s_name[STORAGE_NAME_CAP];
std::atomic<bool> s_button_held{ false };
std::atomic<bool> s_button_dirty{ false };
uint64_t s_verdict_taken;
uint64_t s_line_showing;
int64_t s_clear_at_us;
int64_t s_quiet_until_us;

void publish()
{
    drv_lcd_overlay_t *target = &s_slot[s_next];
    s_builder.build(target);
    s_next = (s_next + 1) % kSlots;
    s_shown.store(target, std::memory_order_release);
}

// A stamp the ring has forgotten leaves the box where the detector put it.
bool travel_since(int64_t stamp_us, int32_t *dx, int32_t *dy)
{
    for (int i = 0; i < kHistory; ++i) {
        if (s_history[i].stamp_us == stamp_us) {
            *dx = s_travel_x - s_history[i].x;
            *dy = s_travel_y - s_history[i].y;
            return true;
        }
    }
    return false;
}

void remember(int64_t stamp_us)
{
    s_travel_x += s_tracker.drift_x();
    s_travel_y += s_tracker.drift_y();
    s_history[s_history_next] = { stamp_us, s_travel_x, s_travel_y };
    s_history_next = (s_history_next + 1) % kHistory;
}

// The detector is accurate but late, the match is on time but drifts: the box
// is the detector's, carried forward by the match (KEHOACH 4.5.5h).
void follow(const uint16_t *pixels, int width, int height, int64_t stamp_us)
{
    s_tracker.update(pixels, width, height);
    remember(stamp_us);

    const Detect *fresh = s_detect.exchange(nullptr, std::memory_order_acquire);
    if (fresh == nullptr) {
        return;
    }
    if (fresh->count <= 0) {
        s_tracker.clear();
        s_builder.set_others(nullptr, 0, width, height);
        return;
    }
    int32_t dx = 0;
    int32_t dy = 0;
    travel_since(fresh->stamp_us, &dx, &dy);
    const ui::Box box = { fresh->box[0][0] + dx, fresh->box[0][1] + dy, fresh->box[0][2] + dx,
                          fresh->box[0][3] + dy };
    s_tracker.anchor(box, pixels, width, height);
    s_builder.set_others(&fresh->box[1][0], fresh->count - 1, fresh->width, fresh->height);
}

bool show(uint64_t packed, int64_t now_us)
{
    s_line_showing = packed;
    s_clear_at_us = now_us + kShowUs;
    s_quiet_until_us = now_us + kQuietUs;
    return s_builder.set_verdict(static_cast<app_ui_verdict_t>(packed >> kVerdictShift),
                                 static_cast<uint32_t>(packed), s_name);
}

bool say_something()
{
    const int64_t now_us = esp_timer_get_time();
    const uint64_t packed = s_verdict.load(std::memory_order_acquire);
    if (packed != s_verdict_taken) {
        s_verdict_taken = packed;
        const bool idle = (packed >> kVerdictShift) <= APP_UI_SCANNING;
        const bool repeat = packed == s_line_showing && now_us < s_quiet_until_us;
        if (!idle && !repeat) {
            return show(packed, now_us);
        }
    }
    if (s_clear_at_us != 0 && now_us >= s_clear_at_us) {
        s_clear_at_us = 0;
        return s_builder.set_verdict(APP_UI_IDLE, 0, nullptr);
    }
    return false;
}

}  // namespace

esp_err_t ui_kiosk_init(void)
{
    if (s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    const esp_err_t err = s_builder.init();
    if (err != ESP_OK) {
        return err;
    }
    memset(s_slot, 0, sizeof(s_slot));
    memset(s_detect_slot, 0, sizeof(s_detect_slot));
    s_ready = true;
    publish();
    ESP_LOGI(TAG, "overlay up, band %d px", ui::OverlayBuilder::kBandHeight);
    return ESP_OK;
}

void ui_kiosk_on_faces(const float *boxes, int count, int frame_width, int frame_height,
                       int64_t stamp_us)
{
    if (!s_ready) {
        return;
    }
    Detect *target = &s_detect_slot[s_detect_next];
    target->count = count < DRV_LCD_OVERLAY_BOXES ? count : DRV_LCD_OVERLAY_BOXES;
    if (target->count > 0) {
        memcpy(target->box, boxes, sizeof(float) * 4 * target->count);
    }
    target->width = frame_width;
    target->height = frame_height;
    target->stamp_us = stamp_us;
    s_detect_next = (s_detect_next + 1) % kSlots;
    s_detect.store(target, std::memory_order_release);
}

void ui_kiosk_on_verdict(app_ui_verdict_t verdict, uint32_t employee_id, const char *name)
{
    // The preview path reads this only once the word below changes, so the
    // order of these two writes is the handover.
    strlcpy(s_name, name != NULL ? name : "", sizeof(s_name));
    const uint64_t packed = ((uint64_t)verdict << kVerdictShift) | employee_id;
    s_verdict.store(packed, std::memory_order_release);
}

bool ui_kiosk_on_touch(bool down, int x, int y)
{
    if (!s_ready) {
        return false;
    }
    const bool inside = x >= ui::OverlayBuilder::kButtonX &&
                        x < ui::OverlayBuilder::kButtonX + ui::OverlayBuilder::kButtonW &&
                        y >= ui::OverlayBuilder::kButtonY &&
                        y < ui::OverlayBuilder::kButtonY + ui::OverlayBuilder::kButtonH;
    const bool was = s_button_held.exchange(down && inside, std::memory_order_acq_rel);
    if (was != (down && inside)) {
        s_button_dirty.store(true, std::memory_order_release);
    }
    // The press is only a press once the finger comes off it again.
    return was && !down;
}

void ui_kiosk_track(const void *pixels, int width, int height, int64_t stamp_us)
{
    if (!s_ready || pixels == NULL) {
        return;
    }
    follow((const uint16_t *)pixels, width, height, stamp_us);
    const ui::Box &held = s_tracker.box();
    const float box[4] = { held.x1, held.y1, held.x2, held.y2 };
    bool changed = s_builder.set_face(s_tracker.active(), box, width, height);
    changed = say_something() || changed;
    if (s_button_dirty.exchange(false, std::memory_order_acq_rel)) {
        changed = s_builder.set_button(s_button_held.load(std::memory_order_acquire)) || changed;
    }
    if (changed) {
        publish();
    }
}

const drv_lcd_overlay_t *ui_kiosk_overlay(void)
{
    return s_shown.load(std::memory_order_acquire);
}
