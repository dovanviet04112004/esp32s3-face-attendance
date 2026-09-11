#include "app_config.h"
#include "bsp_board.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
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

#define RAW_METER_FRAMES 40
#define RAW_DUMP_FRAMES 60
#define RAW_METER_BETWEEN 6
#define RAW_CHUNK_BYTES 2048

static void hex_out(const uint8_t *bytes, size_t len)
{
    static const char digits[] = "0123456789ABCDEF";
    static char line[RAW_CHUNK_BYTES * 2];
    for (size_t at = 0; at < len; at += RAW_CHUNK_BYTES) {
        const size_t take = len - at < RAW_CHUNK_BYTES ? len - at : RAW_CHUNK_BYTES;
        for (size_t i = 0; i < take; ++i) {
            line[2 * i] = digits[bytes[at + i] >> 4];
            line[2 * i + 1] = digits[bytes[at + i] & 0x0F];
        }
        fwrite(line, 1, take * 2, stdout);
    }
    fflush(stdout);
}

// Console writes drop bytes whenever the host lags, and the driver that makes
// them block also takes the RX path the unity menu polls, so it goes in last.
static void blocking_console(void)
{
    static bool installed;
    if (installed) {
        return;
    }
    usb_serial_jtag_driver_config_t console = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    TEST_ASSERT_EQUAL(ESP_OK, usb_serial_jtag_driver_install(&console));
    usb_serial_jtag_vfs_use_driver();
    installed = true;
}

TEST_CASE("metered frames reach the host as raw rgb565", "[drv_camera][manual]")
{
    blocking_console();
    for (int i = 0; i < RAW_METER_FRAMES; ++i) {
        camera_fb_t *frame = drv_camera_grab();
        TEST_ASSERT_NOT_NULL(frame);
        TEST_ASSERT_EQUAL(ESP_OK, drv_camera_expose(frame));
        drv_camera_release(frame);
    }
    for (int i = 0; i < RAW_DUMP_FRAMES; ++i) {
        for (int m = 0; m < RAW_METER_BETWEEN; ++m) {
            camera_fb_t *metered = drv_camera_grab();
            TEST_ASSERT_NOT_NULL(metered);
            TEST_ASSERT_EQUAL(ESP_OK, drv_camera_expose(metered));
            drv_camera_release(metered);
        }
        camera_fb_t *frame = drv_camera_grab();
        TEST_ASSERT_NOT_NULL(frame);
        int level, exposure, gain16;
        drv_camera_exposure_state(&level, &exposure, &gain16);
        printf("\n--RAW %ux%u level %d exposure %d gain16 %d--\n", (unsigned)frame->width,
               (unsigned)frame->height, level, exposure, gain16);
        hex_out(frame->buf, frame->len);
        printf("\n--END--\n");
        drv_camera_release(frame);
    }
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
    unity_run_menu();
}
