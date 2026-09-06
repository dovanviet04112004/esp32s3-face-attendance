#include "drv_lcd.h"

#include <string.h>

#include "app_config.h"
#include "app_err.h"
#include "bsp_board.h"
#include "driver/ledc.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_st7796.h"
#include "esp_log.h"

static const char *TAG = "drv_lcd";

#define BLK_TIMER LEDC_TIMER_0
#define BLK_CHANNEL LEDC_CHANNEL_0
#define BLK_DUTY_BITS LEDC_TIMER_10_BIT
#define BLK_DUTY_MAX ((1u << BLK_DUTY_BITS) - 1u)
#define PANEL_CMD_BITS 8
#define PANEL_PARAM_BITS 8

static esp_lcd_panel_handle_t s_panel;
static esp_lcd_panel_io_handle_t s_io;

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

static esp_err_t panel_up(void)
{
    const esp_lcd_panel_io_spi_config_t io_cfg = {
        .cs_gpio_num = APP_LCD_CS_GPIO,
        .dc_gpio_num = APP_LCD_DC_GPIO,
        .spi_mode = 0,
        .pclk_hz = APP_LCD_SPI_HZ,
        .trans_queue_depth = 10,
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
    APP_RETURN_ON_ERR(esp_lcd_panel_invert_color(s_panel, true), TAG, "invert");
    APP_RETURN_ON_ERR(esp_lcd_panel_swap_xy(s_panel, true), TAG, "swap xy");
    APP_RETURN_ON_ERR(esp_lcd_panel_mirror(s_panel, true, false), TAG, "mirror");
    return esp_lcd_panel_disp_on_off(s_panel, true);
}

esp_err_t drv_lcd_init(void)
{
    if (s_panel != NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    APP_RETURN_ON_ERR(backlight_up(), TAG, "backlight");
    APP_RETURN_ON_ERR(panel_up(), TAG, "panel");
    ESP_LOGI(TAG, "st7796 up at %dx%d", APP_LCD_H_RES, APP_LCD_V_RES);
    return ESP_OK;
}

esp_err_t drv_lcd_backlight(uint8_t percent)
{
    const uint32_t duty = (percent > 100 ? 100u : percent) * BLK_DUTY_MAX / 100u;
    APP_RETURN_ON_ERR(ledc_set_duty(LEDC_LOW_SPEED_MODE, BLK_CHANNEL, duty), TAG, "duty");
    return ledc_update_duty(LEDC_LOW_SPEED_MODE, BLK_CHANNEL);
}

esp_err_t drv_lcd_blit(int x1, int y1, int x2, int y2, const void *pixels)
{
    return esp_lcd_panel_draw_bitmap(s_panel, x1, y1, x2, y2, pixels);
}

esp_err_t drv_lcd_fill(uint16_t rgb565)
{
    // DMA cannot reach PSRAM on this path, so the scratch line stays internal.
    uint16_t *line = heap_caps_malloc(APP_LCD_H_RES * sizeof(uint16_t), MALLOC_CAP_DMA);
    if (line == NULL) {
        return ESP_ERR_NO_MEM;
    }
    for (int x = 0; x < APP_LCD_H_RES; ++x) {
        line[x] = rgb565;
    }
    esp_err_t err = ESP_OK;
    for (int y = 0; y < APP_LCD_V_RES && err == ESP_OK; ++y) {
        err = drv_lcd_blit(0, y, APP_LCD_H_RES, y + 1, line);
    }
    heap_caps_free(line);
    return err;
}

esp_lcd_panel_handle_t drv_lcd_panel(void)
{
    return s_panel;
}
