#include "drv_camera.h"

#include "app_config.h"
#include "app_err.h"
#include "esp_log.h"
#include "esp_timer.h"
#include <stdio.h>
#include <stdlib.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "drv_camera";

#define CAM_LEDC_TIMER LEDC_TIMER_1
#define CAM_LEDC_CHANNEL LEDC_CHANNEL_1
#define CAM_FB_COUNT 2
#define CAM_JPEG_QUALITY 12
#define SELFTEST_FRAMES 20
#define DUMP_JPEG_QUALITY 90
#define SWEEP_SETTLE_MS 300
#define SWEEP_WARMUP 5

static bool s_ready;

esp_err_t drv_camera_init(void)
{
    if (s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    const camera_config_t cfg = {
        .pin_pwdn = APP_CAM_PWDN_GPIO,
        .pin_reset = APP_CAM_RESET_GPIO,
        .pin_xclk = APP_CAM_XCLK_GPIO,
        .pin_sccb_sda = APP_CAM_SIOD_GPIO,
        .pin_sccb_scl = APP_CAM_SIOC_GPIO,
        .pin_d7 = APP_CAM_D7_GPIO,
        .pin_d6 = APP_CAM_D6_GPIO,
        .pin_d5 = APP_CAM_D5_GPIO,
        .pin_d4 = APP_CAM_D4_GPIO,
        .pin_d3 = APP_CAM_D3_GPIO,
        .pin_d2 = APP_CAM_D2_GPIO,
        .pin_d1 = APP_CAM_D1_GPIO,
        .pin_d0 = APP_CAM_D0_GPIO,
        .pin_vsync = APP_CAM_VSYNC_GPIO,
        .pin_href = APP_CAM_HREF_GPIO,
        .pin_pclk = APP_CAM_PCLK_GPIO,
        .xclk_freq_hz = APP_CAM_XCLK_HZ,
        // Timer 0 and channel 0 drive the LCD backlight, so the sensor clock
        // takes the next pair rather than silently stealing that one.
        .ledc_timer = CAM_LEDC_TIMER,
        .ledc_channel = CAM_LEDC_CHANNEL,
        .pixel_format = PIXFORMAT_RGB565,
        .frame_size = FRAMESIZE_HVGA,
        .jpeg_quality = CAM_JPEG_QUALITY,
        .fb_count = CAM_FB_COUNT,
        .fb_location = CAMERA_FB_IN_PSRAM,
        .grab_mode = CAMERA_GRAB_LATEST,
    };
    APP_RETURN_ON_ERR(esp_camera_init(&cfg), TAG, "sensor init");

    sensor_t *sensor = esp_camera_sensor_get();
    if (sensor == NULL) {
        return ESP_ERR_NOT_FOUND;
    }
    // The module sits with the lens above the connector, so the sensor's own
    // frame arrives upside down (KEHOACH 2.1).
    sensor->set_vflip(sensor, 1);
    sensor->set_hmirror(sensor, 1);
    s_ready = true;
    ESP_LOGI(TAG, "sensor 0x%04X up at %dx%d rgb565 in psram", sensor->id.PID, APP_LCD_H_RES,
             APP_LCD_V_RES);
    return ESP_OK;
}

camera_fb_t *drv_camera_grab(void)
{
    return esp_camera_fb_get();
}

void drv_camera_release(camera_fb_t *frame)
{
    if (frame != NULL) {
        esp_camera_fb_return(frame);
    }
}

esp_err_t drv_camera_dump(void)
{
#if !CONFIG_DRV_CAMERA_SELFTEST
    return ESP_OK;
#else
    camera_fb_t *frame = drv_camera_grab();
    if (frame == NULL) {
        return ESP_ERR_TIMEOUT;
    }
    uint8_t *jpeg = NULL;
    size_t jpeg_len = 0;
    const bool ok = frame2jpg(frame, DUMP_JPEG_QUALITY, &jpeg, &jpeg_len);
    const size_t width = frame->width;
    const size_t height = frame->height;
    drv_camera_release(frame);
    if (!ok) {
        return ESP_ERR_NO_MEM;
    }
    printf("\n--FRAME %ux%u %u--\n", (unsigned)width, (unsigned)height, (unsigned)jpeg_len);
    for (size_t i = 0; i < jpeg_len; ++i) {
        printf("%02X", jpeg[i]);
    }
    printf("\n--END--\n");
    free(jpeg);
    return ESP_OK;
#endif
}

esp_err_t drv_camera_selftest(void)
{
#if !CONFIG_DRV_CAMERA_SELFTEST
    return ESP_OK;
#else
    for (int warm = 0; warm < SWEEP_WARMUP; ++warm) {
        drv_camera_release(drv_camera_grab());
    }
    const int64_t started = esp_timer_get_time();
    int taken = 0;
    size_t width = 0, height = 0, bytes = 0;
    for (int i = 0; i < SELFTEST_FRAMES; ++i) {
        camera_fb_t *frame = drv_camera_grab();
        if (frame == NULL) {
            continue;
        }
        width = frame->width;
        height = frame->height;
        bytes = frame->len;
        drv_camera_release(frame);
        taken++;
    }
    const int64_t elapsed_us = esp_timer_get_time() - started;
    const int mfps = elapsed_us > 0 ? (int)((int64_t)taken * 1000000000 / elapsed_us) : 0;
    ESP_LOGI(TAG, "%ux%u  %u B/frame  %d.%03d fps", (unsigned)width, (unsigned)height,
             (unsigned)bytes, mfps / 1000, mfps % 1000);
    return taken > 0 ? ESP_OK : ESP_ERR_TIMEOUT;
#endif
}
