/** Turns the last face and the last verdict into pixels drv_lcd can stripe out.
 *  @ctx task | non-blocking after init | pixels sit in PSRAM, panel byte order
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "app_events.h"
#include "drv_lcd.h"
#include "esp_err.h"

namespace ui {

class OverlayBuilder {
public:
    static constexpr int kCardWidth = 260;
    static constexpr int kCardHeight = 140;
    static constexpr int kCards = 2;

    esp_err_t init() noexcept;

    /** @ret false when the box lands on the pixels it already covers */
    bool set_face(bool found, const float box[4], int frame_width, int frame_height) noexcept;

    /** @ret false when the verdict is the one already showing */
    bool set_verdict(app_ui_verdict_t verdict, uint32_t employee_id) noexcept;

    void build(drv_lcd_overlay_t *out) noexcept;

private:
    uint16_t *card_pixels() noexcept;
    void paint_card() noexcept;

    uint16_t *card_[kCards] = { nullptr, nullptr };
    int next_card_ = 0;
    int shown_card_ = 0;
    int16_t face_[4] = { 0, 0, 0, 0 };
    bool face_found_ = false;
    app_ui_verdict_t verdict_ = APP_UI_IDLE;
    uint32_t employee_id_ = 0;
};

}  // namespace ui
