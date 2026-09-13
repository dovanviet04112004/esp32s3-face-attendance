/** What the kiosk shows: a face box and a message card over the live preview.
 *  @ctx task | non-blocking | cam_task does the drawing, this only publishes
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "app_events.h"
#include "drv_lcd.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Reserve the overlay slots and start with nothing drawn.
 *  @ctx task | blocking | call once from app_boot, after drv_lcd_init
 *  @ret ESP_OK | ESP_ERR_NO_MEM | ESP_ERR_INVALID_STATE if already up
 */
esp_err_t ui_kiosk_init(void);

/** Put the box where the detector last saw a face, in sensor frame pixels.
 *  @ctx ai_task | non-blocking | pass found = false when no face is there
 */
void ui_kiosk_on_face(bool found, const float box[4], int frame_width, int frame_height);

/** Say what the kiosk decided about that face.
 *  @ctx attend_task | non-blocking | employee_id reads 0 unless granted
 */
void ui_kiosk_on_verdict(app_ui_verdict_t verdict, uint32_t employee_id);

/** The overlay to paint over this frame.
 *  @ctx cam_task | non-blocking | read once per frame, never held across frames
 *  @ret NULL while nothing is drawn
 */
const drv_lcd_overlay_t *ui_kiosk_overlay(void);

#ifdef __cplusplus
}
#endif
