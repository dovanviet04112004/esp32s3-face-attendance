#include "ai_engine.h"
#include "app_tasks.h"
#include "bsp_board.h"
#include "drv_camera.h"
#include "drv_ioexp.h"
#include "drv_lcd.h"
#include "drv_touch.h"
#include "net_wifi.h"
#include "esp_log.h"
#include "sys_storage.h"
#include "sys_time.h"

static const char *TAG = "app_main";

#define NVS_RTC_NTP_SET "rtc_ntp_set"

static bool rtc_ntp_marker(void)
{
    uint32_t marker = 0;
    return sys_storage_get_u32(STORAGE_NS_SYS, NVS_RTC_NTP_SET, &marker) == ESP_OK && marker != 0;
}

void app_main(void)
{
    ESP_ERROR_CHECK(sys_storage_init());
    // The arena needs one contiguous run the drivers below would fragment (KEHOACH 3.8).
    ESP_ERROR_CHECK(ai_engine_init());
    ESP_ERROR_CHECK(bsp_board_init());
    ESP_ERROR_CHECK(drv_lcd_init());
    ESP_ERROR_CHECK(drv_lcd_backlight(100));
    ESP_ERROR_CHECK(drv_ioexp_init());
    // A silent clock costs the trust of a timestamp, not the kiosk (KEHOACH 6.2.5).
    const esp_err_t clock = sys_time_init(rtc_ntp_marker());
    if (clock != ESP_OK) {
        ESP_LOGW(TAG, "rtc absent: %s", esp_err_to_name(clock));
    }
    // A dead panel costs the settings screen, not the kiosk (KEHOACH 6.2.2).
    const esp_err_t touch = drv_touch_init();
    if (touch != ESP_OK) {
        ESP_LOGW(TAG, "touch absent: %s", esp_err_to_name(touch));
    }
    ESP_ERROR_CHECK(drv_camera_init());
    // A kiosk with no network still opens doors (KEHOACH 6.2.5).
    const esp_err_t station = net_wifi_start();
    if (station != ESP_OK) {
        ESP_LOGW(TAG, "wifi down: %s", esp_err_to_name(station));
    }
    ESP_ERROR_CHECK(app_tasks_start());
}
