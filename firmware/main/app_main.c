#include "ai_engine.h"
#include "app_tasks.h"
#include "bsp_board.h"
#include "drv_camera.h"
#include "drv_ioexp.h"
#include "drv_lcd.h"
#include "drv_touch.h"
#include "esp_log.h"
#include "sys_storage.h"

static const char *TAG = "app_main";

void app_main(void)
{
    ESP_ERROR_CHECK(sys_storage_init());
    // The arena needs one contiguous run the drivers below would fragment (KEHOACH 3.8).
    ESP_ERROR_CHECK(ai_engine_init());
    ESP_ERROR_CHECK(bsp_board_init());
    ESP_ERROR_CHECK(drv_lcd_init());
    ESP_ERROR_CHECK(drv_lcd_backlight(100));
    ESP_ERROR_CHECK(drv_ioexp_init());
    // A dead panel costs the settings screen, not the kiosk (KEHOACH 6.2.2).
    const esp_err_t touch = drv_touch_init();
    if (touch != ESP_OK) {
        ESP_LOGW(TAG, "touch absent: %s", esp_err_to_name(touch));
    }
    ESP_ERROR_CHECK(drv_camera_init());
    ESP_ERROR_CHECK(app_tasks_start());
}
