/** The GT911 panel: address selection at reset, then touch points.
 *  @ctx task | blocking | reads take m_i2c
 */
#pragma once

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

/** Controller handle for the LVGL port to poll.
 *  @ctx any | non-blocking
 */
esp_lcd_touch_handle_t drv_touch_handle(void);

#ifdef __cplusplus
}
#endif
