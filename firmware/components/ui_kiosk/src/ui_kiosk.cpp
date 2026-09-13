#include "ui_kiosk.h"

#include <atomic>
#include <string.h>

#include "box_tracker.hpp"
#include "esp_log.h"
#include "overlay.hpp"

namespace {

const char *TAG = "ui_kiosk";

constexpr int kSlots = 2;
constexpr uint32_t kVerdictShift = 32;

struct Detect {
    float box[DRV_LCD_OVERLAY_BOXES][4];
    int count;
    int width;
    int height;
    int64_t stamp_us;                     // the frame the detector read
};

// How far the face has travelled since each of the last frames drawn, so a box
// that took 300 ms to compute can be carried forward to now.
struct Travelled {
    int64_t stamp_us;
    int32_t x;
    int32_t y;
};

constexpr int kHistory = 24;

ui::OverlayBuilder s_builder;
ui::BoxTracker s_tracker;
Travelled s_history[kHistory];
int s_history_next;
int32_t s_travel_x;
int32_t s_travel_y;
drv_lcd_overlay_t s_slot[kSlots];
std::atomic<const drv_lcd_overlay_t *> s_shown{ nullptr };
int s_next;
bool s_ready;

// Every write to the builder happens on the preview path, so what the other two
// tasks report arrives through one atomic handover each.
Detect s_detect_slot[kSlots];
std::atomic<const Detect *> s_detect{ nullptr };
int s_detect_next;
std::atomic<uint64_t> s_verdict{ 0 };
uint64_t s_verdict_shown;

void publish()
{
    drv_lcd_overlay_t *target = &s_slot[s_next];
    s_builder.build(target);
    s_next = (s_next + 1) % kSlots;
    s_shown.store(target, std::memory_order_release);
}

bool take_verdict()
{
    const uint64_t packed = s_verdict.load(std::memory_order_acquire);
    if (packed == s_verdict_shown) {
        return false;
    }
    s_verdict_shown = packed;
    return s_builder.set_verdict(static_cast<app_ui_verdict_t>(packed >> kVerdictShift),
                                 static_cast<uint32_t>(packed));
}

// Nothing older than the ring reaches here, and a stamp the ring has forgotten
// leaves the box where the detector put it.
bool travel_since(int64_t stamp_us, int32_t *dx, int32_t *dy)
{
    for (int i = 0; i < kHistory; ++i) {
        const Travelled &seen = s_history[i];
        if (seen.stamp_us == stamp_us) {
            *dx = s_travel_x - seen.x;
            *dy = s_travel_y - seen.y;
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
    const ui::Box box = { fresh->box[0][0] + dx, fresh->box[0][1] + dy,
                          fresh->box[0][2] + dx, fresh->box[0][3] + dy };
    s_tracker.anchor(box, pixels, width, height);
    s_builder.set_others(&fresh->box[1][0], fresh->count - 1, fresh->width, fresh->height);
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
    ESP_LOGI(TAG, "overlay up, card %dx%d", ui::OverlayBuilder::kCardWidth,
             ui::OverlayBuilder::kCardHeight);
    return ESP_OK;
}

void ui_kiosk_on_faces(const float *boxes, int count, int frame_width, int frame_height,
                       int64_t stamp_us)
{
    if (!s_ready) {
        return;
    }
    Detect *target = &s_detect_slot[s_detect_next];
    target->stamp_us = stamp_us;
    target->count = count < DRV_LCD_OVERLAY_BOXES ? count : DRV_LCD_OVERLAY_BOXES;
    if (target->count > 0) {
        memcpy(target->box, boxes, sizeof(float) * 4 * target->count);
    }
    target->width = frame_width;
    target->height = frame_height;
    s_detect_next = (s_detect_next + 1) % kSlots;
    s_detect.store(target, std::memory_order_release);
}

void ui_kiosk_on_verdict(app_ui_verdict_t verdict, uint32_t employee_id)
{
    const uint64_t packed = ((uint64_t)verdict << kVerdictShift) | employee_id;
    s_verdict.store(packed, std::memory_order_release);
}

void ui_kiosk_track(const void *pixels, int width, int height, int64_t stamp_us)
{
    if (!s_ready || pixels == NULL) {
        return;
    }
    const uint16_t *words = (const uint16_t *)pixels;
    follow(words, width, height, stamp_us);
    const ui::Box &held = s_tracker.box();
    const float box[4] = { held.x1, held.y1, held.x2, held.y2 };
    bool changed = s_builder.set_face(s_tracker.active(), box, width, height);
    changed = take_verdict() || changed;
    if (changed) {
        publish();
    }
}

const drv_lcd_overlay_t *ui_kiosk_overlay(void)
{
    return s_shown.load(std::memory_order_acquire);
}
