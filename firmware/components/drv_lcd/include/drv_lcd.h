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

#define DRV_LCD_OVERLAY_MASKS 8
#define DRV_LCD_OVERLAY_BOXES 4

#define DRV_LCD_CLEAR 0                   // lets the video or the ground through
#define DRV_LCD_INK 1
#define DRV_LCD_EDGE 2                    // the shadow that keeps ink legible on video
#define DRV_LCD_ACCENT 3
#define DRV_LCD_WARN 4
#define DRV_LCD_GROUND 5
#define DRV_LCD_SURFACE 6
#define DRV_LCD_SURFACE_HI 7
#define DRV_LCD_LINE 8
#define DRV_LCD_DIM 9
#define DRV_LCD_OK 10
#define DRV_LCD_DANGER 11
#define DRV_LCD_COLOURS 12

#define DRV_LCD_COVER_FULL 15             // opaque, and the path that skips blending

/** Pack a palette index and a 0..15 coverage into one cover cell. */
#define DRV_LCD_CELL(idx, cov) ((uint8_t)((idx) | ((cov) << 4)))

/** Text laid over the preview: one byte a pixel saying what to paint there.
 *  The low nibble indexes palette, the high nibble is coverage; index 0 leaves
 *  what is underneath. palette is in panel byte order (KEHOACH 4.5.5h).
 */
typedef struct {
    int16_t x;
    int16_t y;
    int16_t w;
    int16_t h;
    const uint8_t *cover;                 // DRV_LCD_CELL cells, 0 leaves the video
    int16_t stride;                       // cells per row, so a sub-rectangle can be sent
    const uint16_t *palette;              // DRV_LCD_COLOURS entries
} drv_lcd_mask_t;

/** A hollow rectangle drawn over the preview, in panel pixels. */
typedef struct {
    int16_t x1;
    int16_t y1;
    int16_t x2;                           // one past the last column
    int16_t y2;                           // one past the last row
    uint16_t rgb565;                      // already in panel byte order
    uint8_t edge_px;
} drv_lcd_box_t;

/** What to paint over the preview, cut into strips as the frame is gathered. */
typedef struct {
    uint8_t masks;
    uint8_t boxes;
    bool opaque;                          // the masks cover the panel, no video below
    uint32_t serial;                      // rises whenever the masks change
    drv_lcd_mask_t mask[DRV_LCD_OVERLAY_MASKS];
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

/** Stop or restart the panel controller itself, not just its lamp (KEHOACH 5.4).
 *  @ctx task | blocking | waking holds the caller for the datasheet's 120 ms
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE
 */
esp_err_t drv_lcd_sleep(bool sleeping);

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

/** Paint an overlay on its own, with no camera frame under it.
 *  @ctx task | blocking | for a screen that covers the panel (KEHOACH 4.5.5h)
 */
esp_err_t drv_lcd_paint(const drv_lcd_overlay_t *overlay, uint16_t ground_rgb565);

/** Read a panel status register over the same line the scanline counter uses.
 *  @ctx task | blocking | no lock, so keep it off the blit path
 *  @param reg command byte, one the panel answers with data
 *  @ret its first three reply bytes packed big-endian, 0 when init has not run
 */
uint32_t drv_lcd_read_reg(uint8_t reg);

/** Where the panel's scan sits, counted in the two-line units it reports.
 *  @ctx task | blocking | no lock, so keep it off the blit path
 *  @ret 0 to 241, or -1 when the read does not answer
 */
int drv_lcd_scan_line(void);

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

/** Microseconds the last full-frame blit spent writing, past the phase wait.
 *  @ctx any | non-blocking | 0 until the first frame has gone out
 *  @ret the T_w of KEHOACH 6.4, which must stay inside one scan period
 */
uint32_t drv_lcd_blit_us(void);

/** Panel handle for the LVGL port to drive.
 *  @ctx any | non-blocking
 */
esp_lcd_panel_handle_t drv_lcd_panel(void);

#ifdef __cplusplus
}
#endif
