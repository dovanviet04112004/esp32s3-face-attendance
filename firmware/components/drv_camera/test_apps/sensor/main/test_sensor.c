#include "app_config.h"
#include "bsp_board.h"
#include "driver/gpio.h"
#include "driver/rmt_tx.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "drv_camera.h"
#include "esp_log.h"
#include "esp_rom_serial_output.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sys_storage.h"
#include "unity.h"
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define GRAB_ROUNDS 40
#define RATE_WARMUP 5
#define RATE_FRAMES 20
#define RATE_FLOOR_MFPS 12000
#define DUMP_JPEG_QUALITY 90
// Grabs the closed loop needs to reach its level; a frame taken earlier carries the boot exposure.
#define METER_SETTLE_FRAMES 40

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

static void settle_exposure(void)
{
    for (int i = 0; i < METER_SETTLE_FRAMES; ++i) {
        camera_fb_t *frame = drv_camera_grab();
        TEST_ASSERT_NOT_NULL(frame);
        TEST_ASSERT_EQUAL(ESP_OK, drv_camera_expose(frame));
        drv_camera_release(frame);
    }
}

TEST_CASE("one frame reaches the host as jpeg", "[drv_camera][manual]")
{
    settle_exposure();
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
    const esp_err_t ready = drv_camera_init();
    TEST_ASSERT_TRUE(ready == ESP_OK || ready == ESP_ERR_INVALID_STATE);
    settle_exposure();
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

#define SHOT_DIR "/lfs/shot"
#define SHOT_QUALITY 85
#define SHOT_MAX 150
#define SHOT_MAX_BYTES (3u * 1024u * 1024u + 512u * 1024u)
#define SHOT_PATH_MAX (sizeof(SHOT_DIR) + 1 + 256)
#define BUTTON_POLL_MS 20
#define BUTTON_END_HOLD_MS 2000
#define LED_RESOLUTION_HZ 10000000
#define LED_T0H 3
#define LED_T0L 9
#define LED_T1H 9
#define LED_T1L 3
#define LED_LATCH_US 300
#define LED_FLASH_MS 120

static rmt_channel_handle_t s_led;
static rmt_encoder_handle_t s_led_bytes;

// WS2812 on GPIO48 (KEHOACH 2): a bit is one pulse whose high time carries it,
// so the bytes encoder needs the two durations rather than a clock.
static esp_err_t led_start(void)
{
    if (s_led != NULL) {
        return ESP_OK;
    }
    const rmt_tx_channel_config_t channel = {
        .gpio_num = APP_STATUS_LED_GPIO,
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = LED_RESOLUTION_HZ,
        .mem_block_symbols = 64,
        .trans_queue_depth = 4,
    };
    esp_err_t err = rmt_new_tx_channel(&channel, &s_led);
    if (err != ESP_OK) {
        return err;
    }
    const rmt_bytes_encoder_config_t bytes = {
        .bit0 = { .level0 = 1, .duration0 = LED_T0H, .level1 = 0, .duration1 = LED_T0L },
        .bit1 = { .level0 = 1, .duration0 = LED_T1H, .level1 = 0, .duration1 = LED_T1L },
        .flags.msb_first = 1,
    };
    err = rmt_new_bytes_encoder(&bytes, &s_led_bytes);
    return err == ESP_OK ? rmt_enable(s_led) : err;
}

static void led_show(uint8_t red, uint8_t green, uint8_t blue)
{
    const uint8_t grb[3] = { green, red, blue };
    const rmt_transmit_config_t once = { .loop_count = 0 };
    rmt_transmit(s_led, s_led_bytes, grb, sizeof(grb), &once);
    rmt_tx_wait_all_done(s_led, -1);
    esp_rom_delay_us(LED_LATCH_US);
}

static void led_flash(uint8_t red, uint8_t green, uint8_t blue)
{
    led_show(red, green, blue);
    vTaskDelay(pdMS_TO_TICKS(LED_FLASH_MS));
}

static void button_start(void)
{
    const gpio_config_t boot_button = {
        .pin_bit_mask = 1ULL << APP_FACTORY_RESET_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    TEST_ASSERT_EQUAL(ESP_OK, gpio_config(&boot_button));
}

// Returns how long the button stayed down, so one poll loop reads tap and hold.
static int press_ms(void)
{
    if (gpio_get_level(APP_FACTORY_RESET_GPIO) != 0) {
        return 0;
    }
    int held = 0;
    while (gpio_get_level(APP_FACTORY_RESET_GPIO) == 0 && held < BUTTON_END_HOLD_MS) {
        vTaskDelay(pdMS_TO_TICKS(BUTTON_POLL_MS));
        held += BUTTON_POLL_MS;
    }
    return held;
}

static size_t keep_shot(int index, int scene)
{
    camera_fb_t *frame = drv_camera_grab();
    if (frame == NULL) {
        return 0;
    }
    int level, exposure, gain16;
    drv_camera_exposure_state(&level, &exposure, &gain16);
    uint8_t *jpeg = NULL;
    size_t len = 0;
    const bool encoded = frame2jpg(frame, SHOT_QUALITY, &jpeg, &len);
    drv_camera_release(frame);
    if (!encoded) {
        return 0;
    }
    char path[96];
    snprintf(path, sizeof(path), SHOT_DIR "/s%02d_%03d_L%02d_E%03d_G%02d.jpg", scene, index, level,
             exposure, gain16);
    FILE *out = fopen(path, "wb");
    const size_t put = out != NULL ? fwrite(jpeg, 1, len, out) : 0;
    if (out != NULL) {
        fclose(out);
    }
    free(jpeg);
    printf("kept %s  %u B  level %d exposure %d gain16 %d\n", path, (unsigned)put, level, exposure,
           gain16);
    return put == len ? put : 0;
}

TEST_CASE("the button keeps one frame, the led says whether it landed", "[drv_camera][manual]")
{
    blocking_console();
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_init());
    const esp_err_t up = drv_camera_init();
    TEST_ASSERT_TRUE(up == ESP_OK || up == ESP_ERR_INVALID_STATE);
    mkdir(SHOT_DIR, 0777);
    button_start();
    TEST_ASSERT_EQUAL(ESP_OK, led_start());
    printf("tap BOOT to keep a frame, hold %d s to finish\n", BUTTON_END_HOLD_MS / 1000);

    size_t written = 0;
    int kept = 0, scene = 0;
    bool finished = false;
    // The led is left alone between presses: re-sending it every frame starved
    // the camera's dma and the sensor returned short frames.
    led_show(0, 0, 8);
    while (!finished && kept < SHOT_MAX && written < SHOT_MAX_BYTES) {
        camera_fb_t *warm = drv_camera_grab();
        if (warm != NULL) {
            drv_camera_expose(warm);
            drv_camera_release(warm);
        }
        const int held = press_ms();
        if (held == 0) {
            continue;
        }
        if (held >= BUTTON_END_HOLD_MS) {
            finished = true;
            continue;
        }
        const size_t put = keep_shot(kept, scene);
        led_flash(put == 0 ? 32 : 0, put == 0 ? 0 : 32, 0);
        led_show(0, 0, 8);
        if (put == 0) {
            continue;
        }
        written += put;
        kept++;
    }
    led_show(0, 0, 0);
    printf("kept %d frame(s), %u B in " SHOT_DIR "\n", kept, (unsigned)written);
    TEST_ASSERT_GREATER_THAN(0, kept);
}

TEST_CASE("hand back the frames the button kept", "[drv_camera][manual]")
{
    blocking_console();
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_init());
    DIR *dir = opendir(SHOT_DIR);
    if (dir == NULL) {
        TEST_IGNORE_MESSAGE("no " SHOT_DIR ": the keeping case has not run");
    }
    uint8_t *buffer = heap_caps_malloc(SHOT_MAX_BYTES / 16, MALLOC_CAP_SPIRAM);
    TEST_ASSERT_NOT_NULL(buffer);
    int sent = 0;
    for (struct dirent *entry = readdir(dir); entry != NULL; entry = readdir(dir)) {
        char path[SHOT_PATH_MAX];
        snprintf(path, sizeof(path), SHOT_DIR "/%s", entry->d_name);
        FILE *in = fopen(path, "rb");
        if (in == NULL) {
            continue;
        }
        const size_t len = fread(buffer, 1, SHOT_MAX_BYTES / 16, in);
        fclose(in);
        printf("\n--SHOT %s %u--\n", entry->d_name, (unsigned)len);
        hex_out(buffer, len);
        printf("\n--END--\n");
        sent++;
    }
    closedir(dir);
    free(buffer);
    printf("--SHOTS DONE %d--\n", sent);
}

TEST_CASE("forget the frames the button kept", "[drv_camera][manual]")
{
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_init());
    DIR *dir = opendir(SHOT_DIR);
    if (dir == NULL) {
        TEST_IGNORE_MESSAGE("no " SHOT_DIR " to empty");
    }
    int gone = 0;
    for (struct dirent *entry = readdir(dir); entry != NULL; entry = readdir(dir)) {
        char path[SHOT_PATH_MAX];
        snprintf(path, sizeof(path), SHOT_DIR "/%s", entry->d_name);
        gone += remove(path) == 0 ? 1 : 0;
    }
    closedir(dir);
    printf("removed %d file(s)\n", gone);
}

#define KEEP_CASE "the button keeps one frame, the led says whether it landed"
#define HOST_WINDOW_MS 3000

// A byte from the host inside the window claims the board for the menu; with no
// host there is nobody to pick a case, so the keeping case starts by itself.
static bool host_spoke(void)
{
    uint8_t ch;
    for (int waited = 0; waited < HOST_WINDOW_MS; waited += BUTTON_POLL_MS) {
        if (esp_rom_output_rx_one_char(&ch) == 0) {
            return true;
        }
        vTaskDelay(pdMS_TO_TICKS(BUTTON_POLL_MS));
    }
    return false;
}

void app_main(void)
{
    // The led holds its colour across a reset, so a boot starts by clearing it.
    if (led_start() == ESP_OK) {
        led_show(0, 0, 0);
    }
    // A host that waits out the whole suite loses the menu to the keeping case.
    printf("send any key within %d s for the menu, otherwise the board keeps frames\n",
           HOST_WINDOW_MS / 1000);
    if (host_spoke()) {
        unity_run_menu();
        return;
    }
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
    UNITY_BEGIN();
    unity_run_test_by_name(KEEP_CASE);
    UNITY_END();
    unity_run_menu();
}
