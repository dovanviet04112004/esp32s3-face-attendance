/** The 320x480 panel: bring-up, backlight, and blitting one rectangle.
 *  @ctx task | blocking | uses the SPI bus bsp_board owns
 */
#pragma once

#include <stdint.h>

#include "esp_err.h"
#include "esp_lcd_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Reset the panel, configure it, and leave the backlight off.
 *  @ctx task | blocking | call after bsp_board_init
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE
 */
esp_err_t drv_lcd_init(void);

/** Set backlight brightness.
 *  @ctx task | non-blocking
 *  @param percent 0 for dark, 100 for full
 */
esp_err_t drv_lcd_backlight(uint8_t percent);

/** Copy RGB565 pixels into a rectangle of panel memory.
 *  @ctx task | blocking | the buffer must survive the call
 *  @param x2,y2 one past the last column and row, as esp_lcd expects
 */
esp_err_t drv_lcd_blit(int x1, int y1, int x2, int y2, const void *pixels);

/** Fill the panel from the centre slice of one sensor frame, upright.
 *  @ctx task | blocking | pixels are RGB565 already in the panel's byte order
 *  @param src_width,src_height frame size in pixels, wider than it is tall
 *  @ret ESP_OK | ESP_ERR_INVALID_SIZE when no slice of that shape fits inside
 */
esp_err_t drv_lcd_blit_frame(const void *pixels, int src_width, int src_height);

/** Paint the whole panel one colour.
 *  @ctx task | blocking | goes out through the bounce buffers
 */
esp_err_t drv_lcd_fill(uint16_t rgb565);

/** Panel handle for the LVGL port to drive.
 *  @ctx any | non-blocking
 */
esp_lcd_panel_handle_t drv_lcd_panel(void);

#ifdef __cplusplus
}
#endif
