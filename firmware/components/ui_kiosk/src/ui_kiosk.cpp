#include "ui_kiosk.h"

#include <atomic>
#include <string.h>

#include "esp_log.h"
#include "overlay.hpp"

namespace {

const char *TAG = "ui_kiosk";

constexpr int kSlots = 2;

ui::OverlayBuilder s_builder;
drv_lcd_overlay_t s_slot[kSlots];
std::atomic<const drv_lcd_overlay_t *> s_shown{ nullptr };
int s_next;
bool s_ready;

// The slot cam_task is reading must stay still, so the next look is built in
// the other one and only the pointer moves.
void publish()
{
    drv_lcd_overlay_t *target = &s_slot[s_next];
    s_builder.build(target);
    s_next = (s_next + 1) % kSlots;
    s_shown.store(target, std::memory_order_release);
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
    s_ready = true;
    publish();
    ESP_LOGI(TAG, "overlay up, card %dx%d", ui::OverlayBuilder::kCardWidth,
             ui::OverlayBuilder::kCardHeight);
    return ESP_OK;
}

void ui_kiosk_on_face(bool found, const float box[4], int frame_width, int frame_height)
{
    if (!s_ready || !s_builder.set_face(found, box, frame_width, frame_height)) {
        return;
    }
    publish();
}

void ui_kiosk_on_verdict(app_ui_verdict_t verdict, uint32_t employee_id)
{
    if (!s_ready || !s_builder.set_verdict(verdict, employee_id)) {
        return;
    }
    publish();
}

const drv_lcd_overlay_t *ui_kiosk_overlay(void)
{
    return s_shown.load(std::memory_order_acquire);
}
