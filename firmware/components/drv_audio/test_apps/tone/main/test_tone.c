#include <math.h>
#include <stdint.h>

#include "app_config.h"
#include "bsp_board.h"
#include "drv_audio.h"
#include "drv_ioexp.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "unity.h"

#define CLIP_SAMPLES (DRV_AUDIO_SAMPLE_HZ * 2)
#define BURST_SAMPLES (DRV_AUDIO_SAMPLE_HZ / 2)
#define CLIP_MS (CLIP_SAMPLES * 1000 / DRV_AUDIO_SAMPLE_HZ)
#define LOW_TONE_HZ 440
#define HIGH_TONE_HZ 880
#define TONE_AMPLITUDE 12000
#define QUIET_VOLUME 30
#define LOUD_VOLUME 80
#define SD_BIT (1u << APP_IOEXP_P_AUDIO_SD)
#define MID_CLIP_MS 500
#define AFTER_CLIP_MS 600
#define GAP_MS 700
#define CLOCK_TOLERANCE_MS (CLIP_MS / 10 + 200)
#define PLAYER_STACK_BYTES 4096
#define PLAYER_PRIORITY 6

static int16_t s_clip[CLIP_SAMPLES];

static void fill_tone(size_t samples, int tone_hz)
{
    const float step = 2.0f * (float)M_PI * (float)tone_hz / (float)DRV_AUDIO_SAMPLE_HZ;
    for (size_t i = 0; i < samples; ++i) {
        s_clip[i] = (int16_t)(TONE_AMPLITUDE * sinf(step * (float)i));
    }
}

static void play_clip(void *arg)
{
    (void)arg;
    drv_audio_play_pcm(s_clip, CLIP_SAMPLES);
    vTaskDelete(NULL);
}

static uint8_t sd_line(void)
{
    uint8_t port = 0xFF;
    TEST_ASSERT_EQUAL(ESP_OK, drv_ioexp_read(&port));
    return port & SD_BIT;
}

TEST_CASE("the amp comes up shut down and a second init is refused", "[drv_audio]")
{
    TEST_ASSERT_EQUAL(ESP_OK, bsp_board_init());
    TEST_ASSERT_EQUAL(ESP_OK, drv_ioexp_init());
    TEST_ASSERT_EQUAL(ESP_OK, drv_audio_init());
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, drv_audio_init());
    TEST_ASSERT_EQUAL(0, sd_line());
    printf("listen: low tone 2 s, high tone 2 s, short loud tone; the gaps must be dead silent\n");
}

TEST_CASE("a two second clip occupies the bus for two seconds", "[drv_audio]")
{
    // The write blocks on the DMA ring, so its duration is the sample clock made visible.
    fill_tone(CLIP_SAMPLES, LOW_TONE_HZ);
    TEST_ASSERT_EQUAL(ESP_OK, drv_audio_set_volume(QUIET_VOLUME));
    const int64_t t0 = esp_timer_get_time();
    TEST_ASSERT_EQUAL(ESP_OK, drv_audio_play_pcm(s_clip, CLIP_SAMPLES));
    const int elapsed_ms = (int)((esp_timer_get_time() - t0) / 1000);
    printf("%d ms on the bus for %d ms of samples\n", elapsed_ms, CLIP_MS);
    TEST_ASSERT_INT_WITHIN(CLOCK_TOLERANCE_MS, CLIP_MS, elapsed_ms);
    vTaskDelay(pdMS_TO_TICKS(GAP_MS));
}

TEST_CASE("sd_mode is high for the length of a clip and low after it", "[drv_audio]")
{
    // The expander sources only ~100 uA on a high line, so a high read here means
    // the amp's SD input accepts that as high rather than dragging it down.
    fill_tone(CLIP_SAMPLES, HIGH_TONE_HZ);
    TEST_ASSERT_EQUAL(pdPASS, xTaskCreate(play_clip, "play", PLAYER_STACK_BYTES, NULL, PLAYER_PRIORITY, NULL));
    vTaskDelay(pdMS_TO_TICKS(MID_CLIP_MS));
    const uint8_t during = sd_line();
    vTaskDelay(pdMS_TO_TICKS(CLIP_MS - MID_CLIP_MS + AFTER_CLIP_MS));
    const uint8_t after = sd_line();
    printf("sd_mode mid clip %u, after clip %u\n", during ? 1u : 0u, after ? 1u : 0u);
    TEST_ASSERT_EQUAL(SD_BIT, during);
    TEST_ASSERT_EQUAL(0, after);
    vTaskDelay(pdMS_TO_TICKS(GAP_MS));
}

TEST_CASE("a loud half second burst leaves the board running", "[drv_audio]")
{
    // A brown-out here restarts the runner: count boots in the log, the summary hides it.
    fill_tone(BURST_SAMPLES, LOW_TONE_HZ);
    TEST_ASSERT_EQUAL(ESP_OK, drv_audio_set_volume(LOUD_VOLUME));
    TEST_ASSERT_EQUAL(ESP_OK, drv_audio_play_pcm(s_clip, BURST_SAMPLES));
    TEST_ASSERT_EQUAL(0, sd_line());
    printf("main task stack left %u bytes\n", (unsigned)uxTaskGetStackHighWaterMark(NULL));
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
