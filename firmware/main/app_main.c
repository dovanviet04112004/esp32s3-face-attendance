#include "app_config.h"
#include "bsp_board.h"
#include "drv_lcd.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "app_main";

#define RGB565(r, g, b) (uint16_t)(((r) & 0xF8) << 8 | ((g) & 0xFC) << 3 | (b) >> 3)
#define BRINGUP_HOLD_MS 700

static const uint16_t BRINGUP_COLOURS[] = {
    RGB565(0xFF, 0x00, 0x00),
    RGB565(0x00, 0xFF, 0x00),
    RGB565(0x00, 0x00, 0xFF),
    RGB565(0xFF, 0xFF, 0xFF),
};

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
}
