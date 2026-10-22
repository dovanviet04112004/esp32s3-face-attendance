#include <math.h>
#include <stdint.h>
#include <string.h>

#include "app_config.h"
#include "bsp_board.h"
#include "driver/gpio.h"
#include "driver/i2s_std.h"
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
#define EDGE_WINDOW_US 2000
#define MIN_EDGES 10
#define NOTE_SAMPLES (DRV_AUDIO_SAMPLE_HZ * 2 / 5)
#define NOTE_C5_HZ 523
#define NOTE_E5_HZ 659
#define NOTE_G5_HZ 784
#define NOTE_VOLUME 50
#define KIOSK_VOLUME 60                   // the desk kiosk's level after SET_CONFIG
#define LOOP_GAP_MS 1500
#define WAV_RIFF_BYTES 12
#define WAV_CHUNK_BYTES 8
#define BARE_WRITE_TIMEOUT_MS (CLIP_MS * 2)

// The recording assets/build_assets.py ships as snd/ok.wav, byte for byte.
extern const uint8_t s_shipped_start[] asm("_binary_xincamon_1_1_wav_start");
extern const uint8_t s_shipped_end[] asm("_binary_xincamon_1_1_wav_end");

static const uint8_t LOOP_LEVELS[] = { DRV_AUDIO_VOLUME_MAX, KIOSK_VOLUME, QUIET_VOLUME };
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

static void up_or_already(esp_err_t err)
{
    TEST_ASSERT_TRUE_MESSAGE(err == ESP_OK || err == ESP_ERR_INVALID_STATE, esp_err_to_name(err));
}

TEST_CASE("the amp comes up shut down and a second init is refused", "[drv_audio]")
{
    up_or_already(bsp_board_init());
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

static int edges_on(int gpio)
{
    // Reading the pad back while I2S drives it shows what the wire carries.
    TEST_ASSERT_EQUAL(ESP_OK, gpio_input_enable(gpio));
    int edges = 0;
    int last = gpio_get_level(gpio);
    const int64_t deadline = esp_timer_get_time() + EDGE_WINDOW_US;
    while (esp_timer_get_time() < deadline) {
        const int level = gpio_get_level(gpio);
        edges += level != last;
        last = level;
    }
    return edges;
}

TEST_CASE("sd_mode is high for the length of a clip and low after it", "[drv_audio]")
{
    // The expander sources ~100 uA on a high line; a high read proves the amp's SD pin does not drag it down.
    fill_tone(CLIP_SAMPLES, HIGH_TONE_HZ);
    TEST_ASSERT_EQUAL(pdPASS, xTaskCreate(play_clip, "play", PLAYER_STACK_BYTES, NULL, PLAYER_PRIORITY, NULL));
    vTaskDelay(pdMS_TO_TICKS(MID_CLIP_MS));
    const int bclk = edges_on(APP_AUDIO_BCLK_GPIO);
    const int ws = edges_on(APP_AUDIO_LRC_GPIO);
    const int din = edges_on(APP_AUDIO_DIN_GPIO);
    printf("edges in %d us mid clip: bclk %d, ws %d, din %d\n", EDGE_WINDOW_US, bclk, ws, din);
    TEST_ASSERT_GREATER_THAN(MIN_EDGES, bclk);
    TEST_ASSERT_GREATER_THAN(MIN_EDGES, ws);
    TEST_ASSERT_GREATER_THAN(MIN_EDGES, din);
    const uint8_t during = sd_line();
    vTaskDelay(pdMS_TO_TICKS(CLIP_MS - MID_CLIP_MS + AFTER_CLIP_MS));
    const uint8_t after = sd_line();
    printf("sd_mode mid clip %u, after clip %u\n", during ? 1u : 0u, after ? 1u : 0u);
    TEST_ASSERT_EQUAL(SD_BIT, during);
    TEST_ASSERT_EQUAL(0, after);
    vTaskDelay(pdMS_TO_TICKS(GAP_MS));
}

TEST_CASE("three rising notes for the ear, with silence around them", "[drv_audio]")
{
    const int notes_hz[] = { NOTE_C5_HZ, NOTE_E5_HZ, NOTE_G5_HZ };
    TEST_ASSERT_EQUAL(ESP_OK, drv_audio_set_volume(NOTE_VOLUME));
    printf("listen: three rising notes, then %d ms of silence that must carry no hiss\n", GAP_MS * 3);
    for (size_t i = 0; i < sizeof(notes_hz) / sizeof(notes_hz[0]); ++i) {
        fill_tone(NOTE_SAMPLES, notes_hz[i]);
        TEST_ASSERT_EQUAL(ESP_OK, drv_audio_play_pcm(s_clip, NOTE_SAMPLES));
    }
    vTaskDelay(pdMS_TO_TICKS(GAP_MS * 3));
    TEST_ASSERT_EQUAL(0, sd_line());
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

static const int16_t *shipped_pcm(size_t *samples)
{
    const uint8_t *at = s_shipped_start + WAV_RIFF_BYTES;
    while (at + WAV_CHUNK_BYTES <= s_shipped_end) {
        uint32_t size = 0;
        memcpy(&size, at + 4, sizeof(size));
        if (memcmp(at, "data", 4) == 0) {
            *samples = size / sizeof(int16_t);
            return (const int16_t *)(at + WAV_CHUNK_BYTES);
        }
        at += WAV_CHUNK_BYTES + size + (size & 1u);
    }
    return NULL;
}

static void bare_loop(void)
{
    i2s_chan_handle_t tx = NULL;
    i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
    // The gap would replay the last buffer unless the driver zeroes each one it has sent.
    chan.auto_clear_after_cb = true;
    ESP_ERROR_CHECK(i2s_new_channel(&chan, &tx, NULL));
    const i2s_std_config_t std = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(DRV_AUDIO_SAMPLE_HZ),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = APP_AUDIO_BCLK_GPIO,
            .ws = APP_AUDIO_LRC_GPIO,
            .dout = APP_AUDIO_DIN_GPIO,
            .din = I2S_GPIO_UNUSED,
        },
    };
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx, &std));
    ESP_ERROR_CHECK(i2s_channel_enable(tx));
    size_t samples = 0;
    const int16_t *pcm = shipped_pcm(&samples);
    if (pcm == NULL || samples > CLIP_SAMPLES) {
        printf("bare: the shipped recording is missing or longer than %d samples\n", CLIP_SAMPLES);
        return;
    }
    printf("bare: no expander answered, so SD has to sit on 3V3; the shipped recording straight on I2S, "
           "%u samples at %u, %u and %u %% in turn, %d ms of silence between\n",
           (unsigned)samples, LOOP_LEVELS[0], LOOP_LEVELS[1], LOOP_LEVELS[2], LOOP_GAP_MS);
    for (unsigned round = 0;; ++round) {
        const uint8_t level = LOOP_LEVELS[round % sizeof(LOOP_LEVELS)];
        for (size_t i = 0; i < samples; ++i) {
            s_clip[i] = (int16_t)(((int32_t)pcm[i] * level) / DRV_AUDIO_VOLUME_MAX);
        }
        printf("round %u at %u %%\n", round, level);
        size_t written = 0;
        ESP_ERROR_CHECK(i2s_channel_write(tx, s_clip, samples * sizeof(int16_t), &written, BARE_WRITE_TIMEOUT_MS));
        vTaskDelay(pdMS_TO_TICKS(LOOP_GAP_MS));
    }
}

TEST_CASE("the shipped recording on a loop for the ear, until reset", "[drv_audio][manual]")
{
    // The suite may have stopped part way up: what already answered stays, the rest comes up here.
    up_or_already(bsp_board_init());
    up_or_already(drv_ioexp_init());
    up_or_already(drv_audio_init());
    size_t samples = 0;
    const int16_t *pcm = shipped_pcm(&samples);
    TEST_ASSERT_NOT_NULL(pcm);
    printf("listen: the shipped recording, %u samples, at %u, %u and %u %% in turn, %d ms of silence between\n",
           (unsigned)samples, LOOP_LEVELS[0], LOOP_LEVELS[1], LOOP_LEVELS[2], LOOP_GAP_MS);
    for (unsigned round = 0;; ++round) {
        const uint8_t level = LOOP_LEVELS[round % sizeof(LOOP_LEVELS)];
        TEST_ASSERT_EQUAL(ESP_OK, drv_audio_set_volume(level));
        printf("round %u at %u %%\n", round, level);
        TEST_ASSERT_EQUAL(ESP_OK, drv_audio_play_pcm(pcm, samples));
        vTaskDelay(pdMS_TO_TICKS(LOOP_GAP_MS));
    }
}

void app_main(void)
{
    // A rig of the amp alone carries no expander, so SD sits on 3V3 and only the loop can play.
    if (bsp_board_init() == ESP_ERR_NOT_FOUND) {
        bare_loop();
        return;
    }
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
    // A bench has nobody to pick a case, so the listening loop starts once the suite is through.
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", false);
    UNITY_END();
}
