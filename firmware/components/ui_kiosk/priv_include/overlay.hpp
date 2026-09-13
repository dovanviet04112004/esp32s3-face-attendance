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
    // The detector drops a face for a step or two at kiosk range, and a box
    // that blinks with it is a box nobody sees (KEHOACH 4.5.5h).
    static constexpr int64_t kFaceHoldUs = 700000;

    esp_err_t init() noexcept;

    /** @ret false when the box lands on the pixels it already covers */
    bool set_face(bool found, const float box[4], int frame_width, int frame_height) noexcept;

    /** Boxes the detector saw beside the one being followed, drawn as they came. */
    bool set_others(const float *boxes, int count, int frame_width, int frame_height) noexcept;

    /** @ret false when the verdict is the one already showing */
    bool set_verdict(app_ui_verdict_t verdict, uint32_t employee_id) noexcept;

    void build(drv_lcd_overlay_t *out) noexcept;

private:
    uint16_t *card_pixels() noexcept;
    void paint_card() noexcept;

    uint16_t *card_[kCards] = { nullptr, nullptr };
    int next_card_ = 0;
    int shown_card_ = 0;
    static constexpr int kOthers = DRV_LCD_OVERLAY_BOXES - 1;

    int16_t face_[4] = { 0, 0, 0, 0 };
    int16_t other_[kOthers][4] = {};
    int others_ = 0;
    bool face_found_ = false;
    int64_t face_seen_us_ = 0;
    app_ui_verdict_t verdict_ = APP_UI_IDLE;
    uint32_t employee_id_ = 0;
};

}  // namespace ui
