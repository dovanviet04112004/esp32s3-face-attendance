#include "drv_touch.h"

#include "app_config.h"
#include "app_err.h"
#include "bsp_board.h"
#include "driver/gpio.h"
#include "drv_ioexp.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_touch_gt911.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "drv_touch";

#define TOUCH_ADDR_SELECT_LOW 0
#define SELFTEST_MAX_POINTS 1
#define SELFTEST_POLL_MS 50

static esp_lcd_touch_handle_t s_touch;
static esp_lcd_panel_io_handle_t s_io;

static esp_err_t select_address(void)
{
    const gpio_config_t out = {
        .pin_bit_mask = 1ULL << APP_TOUCH_INT_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
    };
    APP_RETURN_ON_ERR(gpio_config(&out), TAG, "int as output");
    APP_RETURN_ON_ERR(drv_ioexp_set(APP_IOEXP_P_TOUCH_RST, false), TAG, "rst low");
    APP_RETURN_ON_ERR(gpio_set_level(APP_TOUCH_INT_GPIO, TOUCH_ADDR_SELECT_LOW), TAG, "int low");
    vTaskDelay(pdMS_TO_TICKS(APP_TOUCH_RST_HOLD_MS));
    APP_RETURN_ON_ERR(drv_ioexp_set(APP_IOEXP_P_TOUCH_RST, true), TAG, "rst high");
    vTaskDelay(pdMS_TO_TICKS(APP_TOUCH_INT_HOLD_MS));
    return ESP_OK;
}

esp_err_t drv_touch_init(void)
{
    if (s_touch != NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    // The controller latches its address off INT while RST is released, and it
    // is indeterminate until this runs (KEHOACH 2.3).
    APP_RETURN_ON_ERR(select_address(), TAG, "address select");

    esp_lcd_panel_io_i2c_config_t io_cfg = ESP_LCD_TOUCH_IO_I2C_GT911_CONFIG();
    io_cfg.dev_addr = APP_TOUCH_I2C_ADDR_LOW;
    io_cfg.scl_speed_hz = APP_I2C_HZ;
    APP_RETURN_ON_ERR(esp_lcd_new_panel_io_i2c(bsp_i2c_bus(), &io_cfg, &s_io), TAG, "touch io");

    const esp_lcd_touch_config_t cfg = {
        // The controller reports in the panel's own portrait frame, which is
        // the frame swap_xy then turns into the landscape view.
        .x_max = APP_LCD_V_RES,
        .y_max = APP_LCD_H_RES,
        .rst_gpio_num = GPIO_NUM_NC,
        .int_gpio_num = APP_TOUCH_INT_GPIO,
        .flags = {.swap_xy = true, .mirror_x = true, .mirror_y = false},
    };
    APP_RETURN_ON_ERR(esp_lcd_touch_new_i2c_gt911(s_io, &cfg, &s_touch), TAG, "gt911");
    ESP_LOGI(TAG, "gt911 at 0x%02X, %dx%d", APP_TOUCH_I2C_ADDR_LOW, APP_LCD_H_RES, APP_LCD_V_RES);
    return ESP_OK;
}

esp_err_t drv_touch_read(drv_touch_point_t *points, uint8_t max, uint8_t *count)
{
    if (points == NULL || count == NULL || max == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    uint16_t xs[CONFIG_ESP_LCD_TOUCH_MAX_POINTS];
    uint16_t ys[CONFIG_ESP_LCD_TOUCH_MAX_POINTS];
    uint8_t got = 0;

    APP_RETURN_ON_ERR(bsp_i2c_lock(0), TAG, "lock");
    const esp_err_t err = esp_lcd_touch_read_data(s_touch);
    bsp_i2c_unlock();
    APP_RETURN_ON_ERR(err, TAG, "read");

    esp_lcd_touch_get_coordinates(s_touch, xs, ys, NULL, &got, max);
    for (uint8_t i = 0; i < got; ++i) {
        points[i].x = xs[i];
        points[i].y = ys[i];
    }
    *count = got;
    return ESP_OK;
}

esp_err_t drv_touch_selftest(uint8_t seconds)
{
#if !CONFIG_DRV_TOUCH_SELFTEST
    (void)seconds;
    return ESP_OK;
#else
    drv_touch_point_t points[SELFTEST_MAX_POINTS];
    uint8_t count = 0;
    int seen = 0;
    ESP_LOGI(TAG, "touch the panel, watching for %u s", seconds);
    for (int tick = 0; tick < seconds * (1000 / SELFTEST_POLL_MS); ++tick) {
        if (drv_touch_read(points, SELFTEST_MAX_POINTS, &count) == ESP_OK && count) {
            ESP_LOGI(TAG, "touch at %u,%u", points[0].x, points[0].y);
            seen++;
        }
        vTaskDelay(pdMS_TO_TICKS(SELFTEST_POLL_MS));
    }
    ESP_LOGI(TAG, "selftest saw %d contact report(s)", seen);
    return ESP_OK;
#endif
}

esp_lcd_touch_handle_t drv_touch_handle(void)
{
    return s_touch;
}
