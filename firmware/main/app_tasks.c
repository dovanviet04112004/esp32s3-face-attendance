#include "app_tasks.h"

#include "app_config.h"
#include "drv_camera.h"
#include "drv_lcd.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "net_wifi.h"
#include "sys_storage.h"
#include "sys_time.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "app_tasks";

#define CAM_TASK_CORE 0
#define CAM_TASK_PRIORITY 7
#define CAM_TASK_STACK_BYTES 4096
#define RATE_WINDOW_FRAMES 60
#define NET_TASK_CORE 0
#define NET_TASK_PRIORITY 3
#define NET_TASK_STACK_BYTES 4096
#define JOIN_WAIT_MS 30000
#define SNTP_HOST_CAP 64
#define NVS_SNTP_HOST "sntp_host"
#define NVS_RTC_NTP_SET "rtc_ntp_set"

static void report_rate(int frames, int64_t elapsed_us)
{
    const int mfps = elapsed_us > 0 ? (int)((int64_t)frames * 1000000000 / elapsed_us) : 0;
    int level = 0, exposure = 0, gain16 = 0;
    drv_camera_exposure_state(&level, &exposure, &gain16);
    ESP_LOGI(TAG, "preview %d.%03d fps, level %d, exposure %d lines, gain %d/16", mfps / 1000,
             mfps % 1000, level, exposure, gain16);
}

// The marker is what tells a later boot that this clock has been verified, and
// only sys_storage may write it (KEHOACH 6.2.5).
static void on_time_synced(void *arg)
{
    (void)arg;
    const esp_err_t err = sys_storage_set_u32(STORAGE_NS_SYS, NVS_RTC_NTP_SET, 1);
    ESP_LOGI(TAG, "time verified, marker %s", esp_err_to_name(err));
}

// One shot: the clock needs a netif, so the wait belongs off app_main and the
// task leaves once the correction is under way.
static void net_task(void *arg)
{
    (void)arg;
    if (net_wifi_wait_connected(JOIN_WAIT_MS) != ESP_OK) {
        ESP_LOGW(TAG, "no link in %d ms, clock stays on the rtc", JOIN_WAIT_MS);
        vTaskDelete(NULL);
        return;
    }
    char host[SNTP_HOST_CAP] = { 0 };
    const esp_err_t stored = sys_storage_get_str(STORAGE_NS_DEVICE, NVS_SNTP_HOST, host,
                                                 sizeof(host));
    if (stored != ESP_OK) {
        ESP_LOGW(TAG, "no sntp host in nvs: %s", esp_err_to_name(stored));
        vTaskDelete(NULL);
        return;
    }
    const esp_err_t sync = sys_time_sync_start(host, on_time_synced, NULL);
    ESP_LOGI(TAG, "sntp against %s: %s", host, esp_err_to_name(sync));
    vTaskDelete(NULL);
}

static void cam_task(void *arg)
{
    (void)arg;
    int64_t window_started = esp_timer_get_time();
    int frames = 0;
    esp_err_t last_blit = ESP_OK;

    for (;;) {
        camera_fb_t *frame = drv_camera_grab();
        if (frame == NULL) {
            // Spinning here at this priority would starve the idle task and
            // trip the watchdog, so a dry pool costs one tick, not the core.
            vTaskDelay(1);
            continue;
        }
        drv_camera_expose(frame);
        const esp_err_t err = drv_lcd_blit_frame(frame->buf, frame->width, frame->height);
        drv_camera_release(frame);
        if (err != last_blit) {
            ESP_LOGE(TAG, "blit %s", esp_err_to_name(err));
            last_blit = err;
        }
        if (++frames >= RATE_WINDOW_FRAMES) {
            report_rate(frames, esp_timer_get_time() - window_started);
            window_started = esp_timer_get_time();
            frames = 0;
        }
    }
}

esp_err_t app_tasks_start(void)
{
    // Core 1 stays clear for ai_task, whose one Invoke holds a core for
    // 100-400 ms and would stall everything sharing it (KEHOACH 5.1).
    const BaseType_t started = xTaskCreatePinnedToCore(
        cam_task, "cam", CAM_TASK_STACK_BYTES, NULL, CAM_TASK_PRIORITY, NULL, CAM_TASK_CORE);
    if (started != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    const BaseType_t net = xTaskCreatePinnedToCore(net_task, "net", NET_TASK_STACK_BYTES, NULL,
                                                   NET_TASK_PRIORITY, NULL, NET_TASK_CORE);
    return net == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
