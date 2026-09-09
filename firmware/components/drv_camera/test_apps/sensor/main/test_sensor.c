#include "app_config.h"
#include "bsp_board.h"
#include "drv_camera.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "unity.h"
#include <stdio.h>
#include <stdlib.h>

#define GRAB_ROUNDS 40
#define RATE_WARMUP 5
#define RATE_FRAMES 20
#define RATE_FLOOR_MFPS 12000
#define DUMP_JPEG_QUALITY 90

static const char *TAG = "test_sensor";

TEST_CASE("sensor starts and refuses a second init", "[drv_camera]")
{
    TEST_ASSERT_EQUAL(ESP_OK, drv_camera_init());
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, drv_camera_init());
}

TEST_CASE("a frame arrives at the size the pipeline expects", "[drv_camera]")
{
    camera_fb_t *frame = drv_camera_grab();
    TEST_ASSERT_NOT_NULL(frame);
    TEST_ASSERT_EQUAL(APP_CAM_H_RES, frame->width);
    TEST_ASSERT_EQUAL(APP_CAM_V_RES, frame->height);
    TEST_ASSERT_EQUAL(PIXFORMAT_RGB565, frame->format);
    TEST_ASSERT_EQUAL(APP_CAM_H_RES * APP_CAM_V_RES * 2, frame->len);
    drv_camera_release(frame);
}

TEST_CASE("every dvp data line toggles, so no bit is stuck", "[drv_camera]")
{
    // Colour bars exercise all eight lines whatever the room looks like; a
    // stuck-high line shows in the AND of every byte, a stuck-low one in the OR.
    sensor_t *sensor = esp_camera_sensor_get();
    TEST_ASSERT_NOT_NULL(sensor);
    TEST_ASSERT_EQUAL(0, sensor->set_colorbar(sensor, 1));
    drv_camera_release(drv_camera_grab());
    drv_camera_release(drv_camera_grab());
    camera_fb_t *frame = drv_camera_grab();
    TEST_ASSERT_NOT_NULL(frame);
    uint8_t any_high = 0, all_high = 0xFF;
    for (size_t i = 0; i < frame->len; ++i) {
        any_high |= frame->buf[i];
        all_high &= frame->buf[i];
    }
    drv_camera_release(frame);
    TEST_ASSERT_EQUAL(0, sensor->set_colorbar(sensor, 0));
    ESP_LOGI(TAG, "colour bars: byte OR 0x%02X, byte AND 0x%02X", any_high, all_high);
    TEST_ASSERT_EQUAL_HEX8(0xFF, any_high);
    TEST_ASSERT_EQUAL_HEX8(0x00, all_high);
}

TEST_CASE("frames keep coming, so every grab is returned to the pool", "[drv_camera]")
{
    // Three buffers: a grab that forgets to return starves the pool within a
    // few rounds rather than at the end.
    for (int i = 0; i < GRAB_ROUNDS; ++i) {
        camera_fb_t *frame = drv_camera_grab();
        TEST_ASSERT_NOT_NULL(frame);
        drv_camera_release(frame);
    }
}

TEST_CASE("release survives a null frame", "[drv_camera]")
{
    drv_camera_release(NULL);
}

TEST_CASE("the sensor sustains the rate the preview needs", "[drv_camera]")
{
    for (int warm = 0; warm < RATE_WARMUP; ++warm) {
        drv_camera_release(drv_camera_grab());
    }
    const int64_t started = esp_timer_get_time();
    for (int i = 0; i < RATE_FRAMES; ++i) {
        camera_fb_t *frame = drv_camera_grab();
        TEST_ASSERT_NOT_NULL(frame);
        drv_camera_release(frame);
    }
    const int64_t elapsed_us = esp_timer_get_time() - started;
    TEST_ASSERT_GREATER_THAN(0, elapsed_us);
    const int mfps = (int)((int64_t)RATE_FRAMES * 1000000000 / elapsed_us);
    ESP_LOGI(TAG, "%d.%03d fps", mfps / 1000, mfps % 1000);
    TEST_ASSERT_GREATER_OR_EQUAL_MESSAGE(RATE_FLOOR_MFPS, mfps, "below the E7-T11 preview floor");
}

TEST_CASE("one frame reaches the host as jpeg", "[drv_camera][manual]")
{
    camera_fb_t *frame = drv_camera_grab();
    TEST_ASSERT_NOT_NULL(frame);
    uint8_t *jpeg = NULL;
    size_t jpeg_len = 0;
    const bool ok = frame2jpg(frame, DUMP_JPEG_QUALITY, &jpeg, &jpeg_len);
    const size_t width = frame->width;
    const size_t height = frame->height;
    drv_camera_release(frame);
    TEST_ASSERT_TRUE(ok);
    printf("\n--FRAME %ux%u %u--\n", (unsigned)width, (unsigned)height, (unsigned)jpeg_len);
    for (size_t i = 0; i < jpeg_len; ++i) {
        printf("%02X", jpeg[i]);
    }
    printf("\n--END--\n");
    free(jpeg);
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
}
