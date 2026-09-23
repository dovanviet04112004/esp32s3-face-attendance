/** The GT911 panel: address selection at reset, then touch points.
 *  @ctx task | blocking | reads take m_i2c
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "esp_lcd_touch.h"

#ifdef __cplusplus
extern "C" {
#endif

/** One contact, in panel pixels.
 */
typedef struct {
    uint16_t x;
    uint16_t y;
} drv_touch_point_t;

/** Reset the controller onto a known address, then open it.
 *  @ctx task | blocking, holds about 60 ms | call after drv_ioexp_init
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND when the controller stays silent
 */
esp_err_t drv_touch_init(void);

/** Fetch the contacts the controller currently reports.
 *  @ctx task | blocking | takes m_i2c
 *  @param count receives how many of `points` carry a contact, zero for none
 */
esp_err_t drv_touch_read(drv_touch_point_t *points, uint8_t max, uint8_t *count);

/** Wait for the controller to raise INT, which it does when it has a report.
 *  @ctx task | blocking up to timeout_ms | one waiter only
 *  @ret true on INT, false on timeout or with no controller opened
 */
bool drv_touch_wait(uint32_t timeout_ms);

/** Controller handle for the LVGL port to poll.
 *  @ctx any | non-blocking
 */
esp_lcd_touch_handle_t drv_touch_handle(void);

#ifdef __cplusplus
}
#endif
