#include "drv_lcd.h"

#include <inttypes.h>
#include <string.h>

#include "app_config.h"
#include "app_err.h"
#include "bsp_board.h"
#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_st7796.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "drv_lcd";

#define BLK_TIMER LEDC_TIMER_0
#define BLK_CHANNEL LEDC_CHANNEL_0
#define BLK_DUTY_BITS LEDC_TIMER_10_BIT
#define BLK_DUTY_MAX ((1u << BLK_DUTY_BITS) - 1u)
#define PANEL_CMD_BITS 8
#define PANEL_PARAM_BITS 8
#define BOUNCE_ROWS 20
#define BOUNCE_PIXELS (APP_LCD_H_RES * BOUNCE_ROWS)
#define BOUNCE_BYTES (BOUNCE_PIXELS * (int)sizeof(uint16_t))
#define BOUNCE_COUNT 2
#define BOUNCE_WAIT_MS 200
// The st7796 component ships disp_on_off but no disp_sleep, so these go raw.
#define SLEEP_IN_CMD 0x10
#define SLEEP_OUT_CMD 0x11
#define DISPLAY_OFF_CMD 0x28
#define DISPLAY_ON_CMD 0x29
#define SLEEP_OUT_SETTLE_MS 120
#define SLEEP_IN_SETTLE_MS 5
#define CMDSET_REG 0xF0
#define CMDSET_UNLOCK_A 0xC3
#define CMDSET_UNLOCK_B 0x96
#define CMDSET_LOCK_A 0x3C
#define CMDSET_LOCK_B 0x69
#define FRAME_RATE_REG 0xB1
#define FRAME_RATE_DIVA 0x81
#define FRAME_RATE_RTNA 0x1F
// The module ships one of ili9486, ili9488 or st7796s (KMRTM40045 spec sheet).
#define CHIP_ID_REG 0xD3
#define READ_REG_BYTES 4
#define SCANLINE_REG 0x45
#define SCANLINE_UNITS 242
#define SCANLINE_LEAD_MIN 160
#define SCANLINE_LEAD_MAX 200
#define SCANLINE_RETRIES 4
#define SYNC_TICK_CEILING 60
#define CS_FRAME_GAP_US 1

static esp_lcd_panel_handle_t s_panel;
static esp_lcd_panel_io_handle_t s_io;
static uint16_t *s_bounce[BOUNCE_COUNT];
static uint32_t s_blit_us;
static SemaphoreHandle_t s_bounce_free;
static int s_next;
static uint16_t s_column_map[APP_LCD_H_RES];
static int s_map_width;
static spi_device_handle_t s_reader;

static esp_err_t backlight_up(void)
{
    const ledc_timer_config_t timer = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .timer_num = BLK_TIMER,
        .duty_resolution = BLK_DUTY_BITS,
        .freq_hz = APP_LCD_BLK_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    APP_RETURN_ON_ERR(ledc_timer_config(&timer), TAG, "blk timer");
    const ledc_channel_config_t channel = {
        .gpio_num = APP_LCD_BLK_GPIO,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = BLK_CHANNEL,
        .timer_sel = BLK_TIMER,
        .duty = 0,
        .hpoint = 0,
    };
    return ledc_channel_config(&channel);
}

static bool bounce_sent(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *event,
                        void *ctx)
{
    (void)io;
    (void)event;
    (void)ctx;
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(s_bounce_free, &woken);
    return woken == pdTRUE;
}

static esp_err_t chip_select_up(void)
{
    const gpio_config_t cs = {
        .pin_bit_mask = 1ULL << APP_LCD_CS_GPIO,
        .mode = GPIO_MODE_OUTPUT,
    };
    APP_RETURN_ON_ERR(gpio_config(&cs), TAG, "cs");
    return gpio_set_level(APP_LCD_CS_GPIO, 0);
}

static esp_err_t reader_up(void)
{
    // The bus leaves this pin driven, and the panel cannot pull it low: every read comes back all ones.
    APP_RETURN_ON_ERR(gpio_set_direction(APP_LCD_SDO_GPIO, GPIO_MODE_INPUT), TAG, "sdo as input");
    const spi_device_interface_config_t cfg = {
        .clock_speed_hz = APP_LCD_READ_HZ,
        .mode = 0,
        .spics_io_num = GPIO_NUM_NC,
        .queue_size = 1,
        .flags = SPI_DEVICE_HALFDUPLEX,
    };
    return spi_bus_add_device(bsp_lcd_spi_host(), &cfg, &s_reader);
}

static void slow_the_scan(void)
{
    esp_lcd_panel_io_tx_param(s_io, CMDSET_REG, (uint8_t[]){CMDSET_UNLOCK_A}, 1);
    esp_lcd_panel_io_tx_param(s_io, CMDSET_REG, (uint8_t[]){CMDSET_UNLOCK_B}, 1);
    esp_lcd_panel_io_tx_param(s_io, FRAME_RATE_REG,
                              (uint8_t[]){FRAME_RATE_DIVA, FRAME_RATE_RTNA}, 2);
    esp_lcd_panel_io_tx_param(s_io, CMDSET_REG, (uint8_t[]){CMDSET_LOCK_A}, 1);
    esp_lcd_panel_io_tx_param(s_io, CMDSET_REG, (uint8_t[]){CMDSET_LOCK_B}, 1);
}

static uint32_t read_reg(uint8_t reg)
{
    uint8_t raw[READ_REG_BYTES] = {0};
    gpio_set_direction(APP_LCD_DC_GPIO, GPIO_MODE_OUTPUT);
    gpio_set_level(APP_LCD_CS_GPIO, 1);
    esp_rom_delay_us(CS_FRAME_GAP_US);
    gpio_set_level(APP_LCD_CS_GPIO, 0);
    gpio_set_level(APP_LCD_DC_GPIO, 0);
    spi_transaction_t cmd = {
        .flags = SPI_TRANS_USE_TXDATA,
        .length = 8,
        .tx_data = {reg},
    };
    if (spi_device_polling_transmit(s_reader, &cmd) == ESP_OK) {
        gpio_set_level(APP_LCD_DC_GPIO, 1);
        spi_transaction_t rd = {
            .flags = SPI_TRANS_USE_RXDATA,
            .rxlength = READ_REG_BYTES * 8,
        };
        if (spi_device_polling_transmit(s_reader, &rd) == ESP_OK) {
            memcpy(raw, rd.rx_data, READ_REG_BYTES);
        }
    }
    gpio_set_level(APP_LCD_CS_GPIO, 1);
    esp_rom_delay_us(CS_FRAME_GAP_US);
    gpio_set_level(APP_LCD_CS_GPIO, 0);
    const uint32_t stream = ((uint32_t)raw[0] << 24) | ((uint32_t)raw[1] << 16) |
                            ((uint32_t)raw[2] << 8) | raw[3];
    // The 4-line read clocks one dummy bit out ahead of the data (DS V1.0 9.3.17).
    return (stream << 1) >> 8;
}

static int scan_line(void)
{
    uint8_t raw[2] = {0};
    // esp_lcd disables the dc driver after each transaction, and a floating dc turns the command into data.
    gpio_set_direction(APP_LCD_DC_GPIO, GPIO_MODE_OUTPUT);
    gpio_set_level(APP_LCD_CS_GPIO, 1);
    esp_rom_delay_us(CS_FRAME_GAP_US);
    gpio_set_level(APP_LCD_CS_GPIO, 0);
    gpio_set_level(APP_LCD_DC_GPIO, 0);
    spi_transaction_t cmd = {
        .flags = SPI_TRANS_USE_TXDATA,
        .length = 8,
        .tx_data = {SCANLINE_REG},
    };
    esp_err_t err = spi_device_polling_transmit(s_reader, &cmd);
    if (err == ESP_OK) {
        gpio_set_level(APP_LCD_DC_GPIO, 1);
        spi_transaction_t rd = {
            .flags = SPI_TRANS_USE_RXDATA,
            .rxlength = 16,
        };
        err = spi_device_polling_transmit(s_reader, &rd);
        raw[0] = rd.rx_data[0];
        raw[1] = rd.rx_data[1];
    }
    gpio_set_level(APP_LCD_CS_GPIO, 1);
    esp_rom_delay_us(CS_FRAME_GAP_US);
    gpio_set_level(APP_LCD_CS_GPIO, 0);
    return err == ESP_OK ? (((raw[0] & 0x03) << 8) | raw[1]) : -1;
}

static void drain_bounce(void)
{
    for (int i = 0; i < BOUNCE_COUNT; ++i) {
        xSemaphoreTake(s_bounce_free, pdMS_TO_TICKS(BOUNCE_WAIT_MS));
    }
    for (int i = 0; i < BOUNCE_COUNT; ++i) {
        xSemaphoreGive(s_bounce_free);
    }
}

static void wait_for_scan_lead(void)
{
    drain_bounce();
    for (int tick = 0; tick < SYNC_TICK_CEILING; ++tick) {
        // A read right after a panel write lands outside the counter's range, so it is read again (KEHOACH 2.3A).
        int line = scan_line();
        for (int again = 0; again < SCANLINE_RETRIES && (line < 0 || line > SCANLINE_UNITS);
             ++again) {
            line = scan_line();
        }
        if (line < 0 || line > SCANLINE_UNITS) {
            return;
        }
        // The ceiling matters too: it leaves the write a run-up the scan cannot close (KEHOACH 2.3A).
        if (line >= SCANLINE_LEAD_MIN && line <= SCANLINE_LEAD_MAX) {
            return;
        }
        vTaskDelay(1);
    }
}

static esp_err_t panel_up(void)
{
    const esp_lcd_panel_io_spi_config_t io_cfg = {
        .cs_gpio_num = GPIO_NUM_NC,
        .dc_gpio_num = APP_LCD_DC_GPIO,
        .spi_mode = 0,
        .pclk_hz = APP_LCD_SPI_HZ,
        .trans_queue_depth = BOUNCE_COUNT,
        // draw_bitmap returns with the transfer queued; a buffer is free only once this hands it back.
        .on_color_trans_done = bounce_sent,
        .lcd_cmd_bits = PANEL_CMD_BITS,
        .lcd_param_bits = PANEL_PARAM_BITS,
    };
    APP_RETURN_ON_ERR(
        esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)bsp_lcd_spi_host(), &io_cfg, &s_io),
        TAG, "panel io");

    const esp_lcd_panel_dev_config_t dev_cfg = {
        .reset_gpio_num = APP_LCD_RST_GPIO,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR,
        .bits_per_pixel = 16,
    };
    APP_RETURN_ON_ERR(esp_lcd_new_panel_st7796(s_io, &dev_cfg, &s_panel), TAG, "panel");

    APP_RETURN_ON_ERR(esp_lcd_panel_reset(s_panel), TAG, "reset");
    APP_RETURN_ON_ERR(esp_lcd_panel_init(s_panel), TAG, "init");
    // This module shows a negative on INVON and drives its columns reversed, read off test_apps/panel's marks.
    APP_RETURN_ON_ERR(esp_lcd_panel_invert_color(s_panel, false), TAG, "invert");
    APP_RETURN_ON_ERR(esp_lcd_panel_swap_xy(s_panel, false), TAG, "swap xy");
    APP_RETURN_ON_ERR(esp_lcd_panel_mirror(s_panel, true, false), TAG, "mirror");
    // A frame write outlasts the scan, so the scan is slowed until it never catches the writer (KEHOACH 2.3A).
    slow_the_scan();
    return esp_lcd_panel_disp_on_off(s_panel, true);
}

esp_err_t drv_lcd_init(void)
{
    if (s_panel != NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    // SPI DMA reaches internal RAM only: every panel pixel crosses one of these, claimed at boot and kept.
    s_bounce_free = xSemaphoreCreateCounting(BOUNCE_COUNT, BOUNCE_COUNT);
    if (s_bounce_free == NULL) {
        return ESP_ERR_NO_MEM;
    }
    for (int i = 0; i < BOUNCE_COUNT; ++i) {
        s_bounce[i] = heap_caps_malloc(BOUNCE_BYTES, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
        if (s_bounce[i] == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }
    APP_RETURN_ON_ERR(chip_select_up(), TAG, "chip select");
    APP_RETURN_ON_ERR(backlight_up(), TAG, "backlight");
    APP_RETURN_ON_ERR(panel_up(), TAG, "panel");
    APP_RETURN_ON_ERR(reader_up(), TAG, "scanline reader");
    ESP_LOGI(TAG, "panel id %06" PRIx32 " at %dx%d, %d bounce of %d B, scanline reads %d",
             read_reg(CHIP_ID_REG), APP_LCD_H_RES, APP_LCD_V_RES, BOUNCE_COUNT,
             BOUNCE_BYTES, scan_line());
    return ESP_OK;
}

esp_err_t drv_lcd_backlight(uint8_t percent)
{
    const uint32_t duty = (percent > 100 ? 100u : percent) * BLK_DUTY_MAX / 100u;
    APP_RETURN_ON_ERR(ledc_set_duty(LEDC_LOW_SPEED_MODE, BLK_CHANNEL, duty), TAG, "duty");
    return ledc_update_duty(LEDC_LOW_SPEED_MODE, BLK_CHANNEL);
}

esp_err_t drv_lcd_sleep(bool sleeping)
{
    if (s_io == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    const uint8_t first = sleeping ? DISPLAY_OFF_CMD : SLEEP_OUT_CMD;
    const uint8_t second = sleeping ? SLEEP_IN_CMD : DISPLAY_ON_CMD;
    APP_RETURN_ON_ERR(esp_lcd_panel_io_tx_param(s_io, first, NULL, 0), TAG, "first");
    vTaskDelay(pdMS_TO_TICKS(sleeping ? SLEEP_IN_SETTLE_MS : SLEEP_OUT_SETTLE_MS));
    APP_RETURN_ON_ERR(esp_lcd_panel_io_tx_param(s_io, second, NULL, 0), TAG, "second");
    if (sleeping) {
        vTaskDelay(pdMS_TO_TICKS(SLEEP_IN_SETTLE_MS));
    }
    return ESP_OK;
}

static esp_err_t claim_bounce(uint16_t **out)
{
    if (xSemaphoreTake(s_bounce_free, pdMS_TO_TICKS(BOUNCE_WAIT_MS)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    *out = s_bounce[s_next];
    s_next = (s_next + 1) % BOUNCE_COUNT;
    return ESP_OK;
}

static esp_err_t send_bounce(int x1, int y1, int x2, int y2, uint16_t *filled)
{
    const esp_err_t err = esp_lcd_panel_draw_bitmap(s_panel, x1, y1, x2, y2, filled);
    if (err != ESP_OK) {
        xSemaphoreGive(s_bounce_free);
    }
    return err;
}

// The sensor is soldered across the board and only ever sees a lying frame, so
// a standing view is the tallest centre slice that shares the panel's shape.
static bool preview_slice(int src_width, int src_height, int *left, int *taken_width)
{
    if (src_width <= 0 || src_height <= 0) {
        return false;
    }
    const int taken = (src_height * APP_LCD_H_RES) / APP_LCD_V_RES;
    if (taken <= 0 || taken > src_width) {
        return false;
    }
    *left = (src_width - taken) / 2;
    *taken_width = taken;
    return true;
}

static void build_column_map(int src_width, int left, int taken_width)
{
    if (s_map_width == src_width) {
        return;
    }
    for (int x = 0; x < APP_LCD_H_RES; ++x) {
        s_column_map[x] = (uint16_t)(left + (x * taken_width) / APP_LCD_H_RES);
    }
    s_map_width = src_width;
}

// The channels straddle a byte boundary, so a blend has to happen in natural
// order and turn over again on the way out.
static inline uint16_t blend_565(uint16_t over, uint16_t under, uint8_t cover)
{
    const uint16_t a = __builtin_bswap16(over);
    const uint16_t b = __builtin_bswap16(under);
    const int r = (((a >> 11) & 0x1F) * cover + ((b >> 11) & 0x1F) * (15 - cover)) / 15;
    const int g = (((a >> 5) & 0x3F) * cover + ((b >> 5) & 0x3F) * (15 - cover)) / 15;
    const int c = ((a & 0x1F) * cover + (b & 0x1F) * (15 - cover)) / 15;
    return __builtin_bswap16((uint16_t)((r << 11) | (g << 5) | c));
}

static void paint_mask(const drv_lcd_mask_t *mask, uint16_t *strip, int top, int rows)
{
    const int y1 = mask->y > top ? mask->y : top;
    const int y2 = mask->y + mask->h < top + rows ? mask->y + mask->h : top + rows;
    const int x1 = mask->x > 0 ? mask->x : 0;
    const int x2 = mask->x + mask->w < APP_LCD_H_RES ? mask->x + mask->w : APP_LCD_H_RES;
    const uint16_t *palette = mask->palette;
    for (int y = y1; y < y2; ++y) {
        const uint8_t *cover = mask->cover + (size_t)(y - mask->y) * mask->stride + (x1 - mask->x);
        uint16_t *out = strip + (size_t)(y - top) * APP_LCD_H_RES + x1;
        for (int x = 0; x < x2 - x1; ++x) {
            const uint8_t cell = cover[x];
            const uint8_t idx = cell & 0x0Fu;
            if (idx == DRV_LCD_CLEAR) {
                continue;
            }
            const uint8_t level = cell >> 4;
            // Glyph interiors and every solid fill land here; only the rim blends.
            if (level >= DRV_LCD_COVER_FULL) {
                out[x] = palette[idx];
            } else {
                out[x] = blend_565(palette[idx], out[x], level);
            }
        }
    }
}

static void paint_row_span(uint16_t *row, int x1, int x2, uint16_t colour)
{
    const int from = x1 > 0 ? x1 : 0;
    const int to = x2 < APP_LCD_H_RES ? x2 : APP_LCD_H_RES;
    for (int x = from; x < to; ++x) {
        row[x] = colour;
    }
}

static void paint_box(const drv_lcd_box_t *box, uint16_t *strip, int top, int rows)
{
    const int edge = box->edge_px > 0 ? box->edge_px : 1;
    const int y1 = box->y1 > top ? box->y1 : top;
    const int y2 = box->y2 < top + rows ? box->y2 : top + rows;
    for (int y = y1; y < y2; ++y) {
        uint16_t *row = strip + (size_t)(y - top) * APP_LCD_H_RES;
        if (y < box->y1 + edge || y >= box->y2 - edge) {
            paint_row_span(row, box->x1, box->x2, box->rgb565);
            continue;
        }
        paint_row_span(row, box->x1, box->x1 + edge, box->rgb565);
        paint_row_span(row, box->x2 - edge, box->x2, box->rgb565);
    }
}

static void paint_overlay(const drv_lcd_overlay_t *overlay, uint16_t *strip, int top, int rows)
{
    for (uint8_t i = 0; i < overlay->boxes && i < DRV_LCD_OVERLAY_BOXES; ++i) {
        paint_box(&overlay->box[i], strip, top, rows);
    }
    for (uint8_t i = 0; i < overlay->masks && i < DRV_LCD_OVERLAY_MASKS; ++i) {
        if (overlay->mask[i].cover != NULL) {
            paint_mask(&overlay->mask[i], strip, top, rows);
        }
    }
}

esp_err_t drv_lcd_blit_frame(const void *pixels, int src_width, int src_height,
                             const drv_lcd_overlay_t *overlay)
{
    int left = 0;
    int taken_width = 0;
    if (!preview_slice(src_width, src_height, &left, &taken_width)) {
        return ESP_ERR_INVALID_SIZE;
    }
    build_column_map(src_width, left, taken_width);
    wait_for_scan_lead();
    const int64_t started_us = esp_timer_get_time();
    const int rows_per_strip = BOUNCE_PIXELS / APP_LCD_H_RES;
    const uint16_t *src = pixels;

    for (int y = 0; y < APP_LCD_V_RES; y += rows_per_strip) {
        const int rows =
            (y + rows_per_strip <= APP_LCD_V_RES) ? rows_per_strip : APP_LCD_V_RES - y;
        uint16_t *dst = NULL;
        APP_RETURN_ON_ERR(claim_bounce(&dst), TAG, "bounce");
        for (int r = 0; r < rows; ++r) {
            const uint16_t *row =
                src + (size_t)(((y + r) * src_height) / APP_LCD_V_RES) * src_width;
            uint16_t *out = dst + r * APP_LCD_H_RES;
            for (int x = 0; x < APP_LCD_H_RES; ++x) {
                out[x] = row[s_column_map[x]];
            }
        }
        if (overlay != NULL) {
            paint_overlay(overlay, dst, y, rows);
        }
        APP_RETURN_ON_ERR(send_bounce(0, y, APP_LCD_H_RES, y + rows, dst), TAG, "strip");
    }
    s_blit_us = (uint32_t)(esp_timer_get_time() - started_us);
    return ESP_OK;
}

uint32_t drv_lcd_blit_us(void)
{
    return s_blit_us;
}

// A screen that lit one row publishes one mask, and every other strip of the
// panel already holds what it should (KEHOACH 4.5.5h).
static bool strip_wanted(const drv_lcd_overlay_t *overlay, int top, int rows)
{
    for (int i = 0; i < overlay->masks; ++i) {
        const drv_lcd_mask_t *mask = &overlay->mask[i];
        if (mask->y < top + rows && mask->y + mask->h > top) {
            return true;
        }
    }
    for (int i = 0; i < overlay->boxes; ++i) {
        const drv_lcd_box_t *box = &overlay->box[i];
        if (box->y1 < top + rows && box->y2 > top) {
            return true;
        }
    }
    return false;
}

esp_err_t drv_lcd_paint(const drv_lcd_overlay_t *overlay, uint16_t ground_rgb565)
{
    if (overlay == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    // This writes the whole panel too, so it tears like a frame when the scan catches the write (KEHOACH 2.3A).
    wait_for_scan_lead();
    const int rows_per_strip = BOUNCE_PIXELS / APP_LCD_H_RES;
    for (int y = 0; y < APP_LCD_V_RES; y += rows_per_strip) {
        const int rows =
            (y + rows_per_strip <= APP_LCD_V_RES) ? rows_per_strip : APP_LCD_V_RES - y;
        if (!strip_wanted(overlay, y, rows)) {
            continue;
        }
        uint16_t *dst = NULL;
        APP_RETURN_ON_ERR(claim_bounce(&dst), TAG, "bounce");
        for (int i = 0; i < rows * APP_LCD_H_RES; ++i) {
            dst[i] = ground_rgb565;
        }
        paint_overlay(overlay, dst, y, rows);
        APP_RETURN_ON_ERR(send_bounce(0, y, APP_LCD_H_RES, y + rows, dst), TAG, "strip");
    }
    return ESP_OK;
}

bool drv_lcd_panel_to_frame(int src_width, int src_height, const int16_t box[4], float out[4])
{
    int left = 0;
    int taken_width = 0;
    if (box == NULL || out == NULL || !preview_slice(src_width, src_height, &left, &taken_width)) {
        return false;
    }
    const float columns = (float)taken_width / (float)APP_LCD_H_RES;
    const float rows = (float)src_height / (float)APP_LCD_V_RES;
    out[0] = (float)left + (float)box[0] * columns;
    out[1] = (float)box[1] * rows;
    out[2] = (float)left + (float)box[2] * columns;
    out[3] = (float)box[3] * rows;
    return out[2] > out[0] && out[3] > out[1];
}

esp_lcd_panel_handle_t drv_lcd_panel(void)
{
    return s_panel;
}
