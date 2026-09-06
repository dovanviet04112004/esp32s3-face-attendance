#include "app_tasks.h"

#include "app_config.h"
#include "drv_camera.h"
#include "drv_lcd.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "app_tasks";

#define CAM_TASK_CORE 0
#define CAM_TASK_PRIORITY 7
#define CAM_TASK_STACK_BYTES 4096
#define RATE_WINDOW_FRAMES 60

static void report_rate(int frames, int64_t elapsed_us)
{
    const int mfps = elapsed_us > 0 ? (int)((int64_t)frames * 1000000000 / elapsed_us) : 0;
    ESP_LOGI(TAG, "preview %d.%03d fps", mfps / 1000, mfps % 1000);
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
    return started == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
