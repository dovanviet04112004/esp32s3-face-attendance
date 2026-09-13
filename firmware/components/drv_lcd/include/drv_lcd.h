/** The 320x480 panel: bring-up, backlight, and blitting one rectangle.
 *  @ctx task | blocking | uses the SPI bus bsp_board owns
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "esp_lcd_types.h"

#ifdef __cplusplus
extern "C" {
#endif

#define DRV_LCD_OVERLAY_CARDS 2
#define DRV_LCD_OVERLAY_BOXES 4

/** A hollow rectangle drawn over the preview, in panel pixels.
 */
typedef struct {
    int16_t x1;
    int16_t y1;
    int16_t x2;                           // one past the last column
    int16_t y2;                           // one past the last row
    uint16_t rgb565;                      // already in panel byte order
    uint8_t edge_px;
} drv_lcd_box_t;

/** A solid image drawn over the preview, in panel pixels.
 */
typedef struct {
    int16_t x;
    int16_t y;
    int16_t w;
    int16_t h;
    const uint16_t *pixels;               // w*h, already in panel byte order
} drv_lcd_card_t;

/** What to paint over the preview, cut into strips as the frame is gathered.
 *  Pixels arrive in panel byte order because the preview path does not swap:
 *  a camera frame is already the right way round (KEHOACH 4.5.5h).
 */
typedef struct {
    uint8_t cards;
    uint8_t boxes;
    drv_lcd_card_t card[DRV_LCD_OVERLAY_CARDS];
    drv_lcd_box_t box[DRV_LCD_OVERLAY_BOXES];
} drv_lcd_overlay_t;

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
 *  @param overlay painted over the frame in the same pass, NULL for none
 *  @ret ESP_OK | ESP_ERR_INVALID_SIZE when no slice of that shape fits inside
 */
esp_err_t drv_lcd_blit_frame(const void *pixels, int src_width, int src_height,
                             const drv_lcd_overlay_t *overlay);

/** Where a rectangle of the sensor frame lands on the panel.
 *  @ctx any | non-blocking | the same centre slice drv_lcd_blit_frame shows
 *  @param box x1,y1,x2,y2 in frame pixels; out takes panel pixels, clamped
 *  @ret false when no slice of that frame shape fits the panel
 */
bool drv_lcd_frame_to_panel(int src_width, int src_height, const float box[4], int16_t out[4]);

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
