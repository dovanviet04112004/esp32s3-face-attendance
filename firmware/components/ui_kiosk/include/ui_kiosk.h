/** The kiosk's screens: drawn as a cover map cam_task lays over its preview.
 *  @ctx task | non-blocking | ui_task owns the screens, cam_task only reads
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "app_events.h"
#include "drv_lcd.h"
#include "esp_err.h"
#include "storage_format.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Reserve the cover map and open on the scan screen.
 *  @ctx task | blocking | call once from app_boot, after drv_lcd_init
 *  @ret ESP_OK | ESP_ERR_NO_MEM | ESP_ERR_INVALID_STATE if already up
 */
esp_err_t ui_kiosk_init(void);

/** Tell the screens what the detector saw, in sensor frame pixels.
 *  @ctx ai_task | non-blocking | boxes holds count sets of four
 *  @param face_min_px the gate below which the kiosk asks the person to come closer
 */
void ui_kiosk_on_faces(const float *boxes, int count, int frame_width, int frame_height,
                       int face_min_px);

/** Say what the kiosk decided about that face.
 *  @ctx attend_task | non-blocking | employee_id and name read empty unless granted
 */
void ui_kiosk_on_verdict(app_ui_verdict_t verdict, uint32_t employee_id, const char *name);

/** Hand one touch to the screen showing.
 *  @ctx touch_task | non-blocking | down = false when the finger lifts
 */
void ui_kiosk_on_touch(bool down, int x, int y);

/** Run the screen showing and repaint it when it has something new to say.
 *  @ctx ui_task | non-blocking | dt_ms is the time since the last call
 */
void ui_kiosk_tick(uint32_t dt_ms);

/** Collect a face the enrol screen is waiting for.
 *  @ctx ui_task | non-blocking | one shot: the request clears as it is taken
 *  @ret false when no screen is asking for one
 */
bool ui_kiosk_take_enrol(uint32_t *employee_id, uint16_t *template_idx, char *name, size_t cap);

/** The cover map to paint over this frame.
 *  @ctx cam_task | non-blocking | read once per frame
 *  @ret NULL until the first screen has been painted
 */
const drv_lcd_overlay_t *ui_kiosk_overlay(void);

#ifdef __cplusplus
}
#endif
