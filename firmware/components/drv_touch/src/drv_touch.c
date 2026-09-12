#include "drv_touch.h"

#include <string.h>

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
#define TOUCH_LOCK_MS 200
#define PRODUCT_ID_REG 0x8140
#define PRODUCT_ID_LEN 3
#define PRODUCT_ID_GT911 "911"

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
    // The controller answers nothing on i2c while this end drives its INT.
    const gpio_config_t back_to_input = {
        .pin_bit_mask = 1ULL << APP_TOUCH_INT_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
    };
    APP_RETURN_ON_ERR(gpio_config(&back_to_input), TAG, "int as input");
    return ESP_OK;
}

static esp_err_t check_product_id(void)
{
    uint8_t id[PRODUCT_ID_LEN] = {0};
    uint8_t again[PRODUCT_ID_LEN] = {0};
    // A panel whose flex is unseated still acks its address and serves noise,
    // and the gt911 component logs the id it reads without checking it.
    APP_RETURN_ON_ERR(esp_lcd_panel_io_rx_param(s_io, PRODUCT_ID_REG, id, sizeof(id)), TAG, "id");
    APP_RETURN_ON_ERR(esp_lcd_panel_io_rx_param(s_io, PRODUCT_ID_REG, again, sizeof(again)), TAG,
                      "id again");
    if (memcmp(id, PRODUCT_ID_GT911, PRODUCT_ID_LEN) != 0 ||
        memcmp(id, again, PRODUCT_ID_LEN) != 0) {
        ESP_LOGE(TAG, "id 0x%02X%02X%02X then 0x%02X%02X%02X, expected \"911\"", id[0], id[1],
                 id[2], again[0], again[1], again[2]);
        return ESP_ERR_NOT_FOUND;
    }
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
    APP_RETURN_ON_ERR(check_product_id(), TAG, "product id");

    const esp_lcd_touch_config_t cfg = {
        // The controller reports in the panel's own portrait frame, which is
        // the frame the display now uses, so nothing needs turning.
        .x_max = APP_LCD_H_RES,
        .y_max = APP_LCD_V_RES,
        .rst_gpio_num = GPIO_NUM_NC,
        .int_gpio_num = APP_TOUCH_INT_GPIO,
        .flags = {.swap_xy = false, .mirror_x = false, .mirror_y = false},
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
    if (s_touch == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    uint16_t xs[CONFIG_ESP_LCD_TOUCH_MAX_POINTS];
    uint16_t ys[CONFIG_ESP_LCD_TOUCH_MAX_POINTS];
    // esp_lcd_touch fills up to the count it is handed, so a caller asking for
    // more than these arrays hold would write past them.
    const uint8_t room = max < CONFIG_ESP_LCD_TOUCH_MAX_POINTS
                             ? max
                             : (uint8_t)CONFIG_ESP_LCD_TOUCH_MAX_POINTS;
    uint8_t got = 0;

    APP_RETURN_ON_ERR(bsp_i2c_lock(TOUCH_LOCK_MS), TAG, "lock");
    const esp_err_t err = esp_lcd_touch_read_data(s_touch);
    bsp_i2c_unlock();
    APP_RETURN_ON_ERR(err, TAG, "read");

    esp_lcd_touch_get_coordinates(s_touch, xs, ys, NULL, &got, room);
    for (uint8_t i = 0; i < got; ++i) {
        points[i].x = xs[i];
        points[i].y = ys[i];
    }
    *count = got;
    return ESP_OK;
}

esp_lcd_touch_handle_t drv_touch_handle(void)
{
    return s_touch;
}
