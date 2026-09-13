/** Turns a verdict into the line of text the kiosk lays over its own preview.
 *  @ctx task | non-blocking after init | the cover map sits in PSRAM
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "app_config.h"
#include "app_events.h"
#include "drv_lcd.h"
#include "esp_err.h"

namespace ui {

class OverlayBuilder {
public:
    static constexpr int kBandHeight = 104;
    static constexpr int kButtonW = 168;
    static constexpr int kButtonH = 46;
    static constexpr int kButtonX = (APP_LCD_H_RES - kButtonW) / 2;
    static constexpr int kButtonY = 18;
    static constexpr int kSlots = 2;

    esp_err_t init() noexcept;

    /** @ret false when the verdict already showing says the same thing */
    bool set_verdict(app_ui_verdict_t verdict, uint32_t employee_id, const char *name) noexcept;

    /** The face being worked on, in sensor frame pixels. */
    bool set_face(bool found, const float box[4], int frame_width, int frame_height) noexcept;

    /** Faces the detector saw beside that one, drawn where it put them. */
    bool set_others(const float *boxes, int count, int frame_width, int frame_height) noexcept;

    void build(drv_lcd_overlay_t *out) noexcept;

    /** @ret false when the button already looks the way it is being asked to */
    bool set_button(bool held) noexcept;

private:
    void draw(const char *line, const char *under) noexcept;
    void draw_granted(const char *who) noexcept;

    static constexpr int kOthers = DRV_LCD_OVERLAY_BOXES - 1;

    uint8_t *button_ = nullptr;
    bool button_held_ = false;
    uint8_t *cover_[kSlots] = { nullptr, nullptr };
    int16_t face_[4] = { 0, 0, 0, 0 };
    int16_t other_[kOthers][4] = {};
    int others_ = 0;
    bool face_found_ = false;
    int next_ = 0;
    int shown_ = -1;
    app_ui_verdict_t verdict_ = APP_UI_IDLE;
    uint32_t employee_id_ = 0;
};

}  // namespace ui
