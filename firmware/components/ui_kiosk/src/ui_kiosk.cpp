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
};

ui::OverlayBuilder s_builder;
ui::BoxTracker s_tracker;
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

// A detect lands three times a second; between two of them the patch match is
// what keeps the box on the face (KEHOACH 4.5.5h).
void follow(const uint16_t *pixels, int width, int height)
{
    const Detect *fresh = s_detect.exchange(nullptr, std::memory_order_acquire);
    if (fresh == nullptr) {
        s_tracker.update(pixels, width, height);
        return;
    }
    if (fresh->count <= 0) {
        s_tracker.clear();
        s_builder.set_others(nullptr, 0, width, height);
        return;
    }
    const ui::Box box = { fresh->box[0][0], fresh->box[0][1], fresh->box[0][2], fresh->box[0][3] };
    s_tracker.set(box, pixels, fresh->width, fresh->height, true);
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

void ui_kiosk_on_faces(const float *boxes, int count, int frame_width, int frame_height)
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
    s_detect_next = (s_detect_next + 1) % kSlots;
    s_detect.store(target, std::memory_order_release);
}

void ui_kiosk_on_verdict(app_ui_verdict_t verdict, uint32_t employee_id)
{
    const uint64_t packed = ((uint64_t)verdict << kVerdictShift) | employee_id;
    s_verdict.store(packed, std::memory_order_release);
}

void ui_kiosk_track(const void *pixels, int width, int height)
{
    if (!s_ready || pixels == NULL) {
        return;
    }
    const uint16_t *words = (const uint16_t *)pixels;
    follow(words, width, height);
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
