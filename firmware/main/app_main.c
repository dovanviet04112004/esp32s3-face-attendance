#include "app_config.h"
#include "bsp_board.h"
#include "driver/i2c_master.h"
#include "drv_lcd.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "app_main";

#define I2C_PROBE_FIRST 0x08
#define I2C_PROBE_LAST 0x77
#define I2C_PROBE_TIMEOUT_MS 20

#define RGB565(r, g, b) (uint16_t)(((r) & 0xF8) << 8 | ((g) & 0xFC) << 3 | (b) >> 3)
#define BRINGUP_HOLD_MS 700

static const uint16_t BRINGUP_COLOURS[] = {
    RGB565(0xFF, 0x00, 0x00),
    RGB565(0x00, 0xFF, 0x00),
    RGB565(0x00, 0x00, 0xFF),
    RGB565(0xFF, 0xFF, 0xFF),
};

static void scan_i2c(void)
{
    i2c_master_bus_handle_t bus = bsp_i2c_bus();
    int found = 0;
    // A silent address is how a scan reports absence, so the driver's own
    // timeout error is noise here and would bury the addresses that answered.
    esp_log_level_set("i2c.master", ESP_LOG_NONE);
    for (uint16_t addr = I2C_PROBE_FIRST; addr <= I2C_PROBE_LAST; ++addr) {
        if (i2c_master_probe(bus, addr, I2C_PROBE_TIMEOUT_MS) == ESP_OK) {
            ESP_LOGI(TAG, "i2c 0x%02X answered", addr);
            found++;
        }
    }
    esp_log_level_set("i2c.master", ESP_LOG_INFO);
    ESP_LOGI(TAG, "i2c scan done, %d device(s)", found);
}

void app_main(void)
{
    ESP_ERROR_CHECK(bsp_board_init());
    ESP_ERROR_CHECK(drv_lcd_init());
    ESP_ERROR_CHECK(drv_lcd_backlight(100));

    for (size_t i = 0; i < sizeof(BRINGUP_COLOURS) / sizeof(BRINGUP_COLOURS[0]); ++i) {
        ESP_ERROR_CHECK(drv_lcd_fill(BRINGUP_COLOURS[i]));
        vTaskDelay(pdMS_TO_TICKS(BRINGUP_HOLD_MS));
    }
    ESP_LOGI(TAG, "panel reached every colour");
    scan_i2c();
}
