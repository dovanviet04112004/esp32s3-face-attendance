#include <stdio.h>
#include <string.h>

#include "ai_engine.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sys_storage.h"
#include "unity.h"

#define EMBED_MAX 512
#define RUNS 20

// One RGB565 frame at the sensor's own size, and the rate cam_task delivers
// them, so the load below moves what the preview really moves (KEHOACH 5.1).
#define FRAME_BYTES (480 * 320 * 2)
#define FRAME_PERIOD_MS 70
#define LOAD_TASK_CORE 0
#define LOAD_TASK_PRIORITY 7
#define LOAD_TASK_STACK_BYTES 3072

// Camera frames live in psram on the real device, and in bss these would take
// the internal ram an arena wants. Sizes come from the graphs themselves.
static int8_t *s_frame;
static int8_t *s_tight;
static int8_t *s_wide;
static int8_t *s_face;
static int8_t s_embedding[EMBED_MAX];

static int8_t *psram(size_t len, int seed)
{
    TEST_ASSERT_GREATER_THAN_UINT(0, len);
    int8_t *buffer = heap_caps_malloc(len, MALLOC_CAP_SPIRAM);
    TEST_ASSERT_NOT_NULL(buffer);
    for (size_t i = 0; i < len; ++i) {
        buffer[i] = (int8_t)(((i * 31) + (seed * 97)) % 255 - 128);
    }
    return buffer;
}

static volatile bool s_load_running;
static volatile uint32_t s_load_frames;

static void psram_load_task(void *arg)
{
    (void)arg;
    uint8_t *source = heap_caps_malloc(FRAME_BYTES, MALLOC_CAP_SPIRAM);
    uint8_t *sink = heap_caps_malloc(FRAME_BYTES, MALLOC_CAP_SPIRAM);
    while (s_load_running) {
        if (source != NULL && sink != NULL) {
            memcpy(sink, source, FRAME_BYTES);
            s_load_frames++;
        }
        vTaskDelay(pdMS_TO_TICKS(FRAME_PERIOD_MS));
    }
    heap_caps_free(source);
    heap_caps_free(sink);
    vTaskDelete(NULL);
}

static esp_err_t run_detect(void)
{
    return ai_engine_detect(s_frame);
}

static esp_err_t run_spoof(void)
{
    float live = 0.0F;
    return ai_engine_spoof(s_tight, s_wide, &live);
}

static esp_err_t run_recog(void)
{
    float scale = 0.0F;
    return ai_engine_recognize(s_face, s_embedding, sizeof(s_embedding), &scale);
}

static int64_t time_runs(esp_err_t (*once)(void), const char *label)
{
    int64_t total = 0, worst = 0, best = INT64_MAX;
    for (int i = 0; i < RUNS; ++i) {
        const int64_t started = esp_timer_get_time();
        TEST_ASSERT_EQUAL(ESP_OK, once());
        const int64_t spent = esp_timer_get_time() - started;
        total += spent;
        worst = spent > worst ? spent : worst;
        best = spent < best ? spent : best;
    }
    printf("%-7s mean %8lld us  min %8lld us  max %8lld us\n", label, (long long)(total / RUNS),
           (long long)best, (long long)worst);
    return total / RUNS;
}

TEST_CASE("all three branches load and report what they took", "[bench_ai]")
{
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_init());
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_init());
    s_frame = psram(ai_engine_detect_input_len(), 1);
    s_tight = psram(ai_engine_spoof_input_len(), 2);
    s_wide = psram(ai_engine_spoof_input_len(), 3);
    s_face = psram(ai_engine_recog_input_len(), 4);

    ai_engine_arena_stats_t stats;
    ai_engine_arena_stats(&stats);
    printf("inputs: detect %u B, spoof %u B, recog %u B\n",
           (unsigned)ai_engine_detect_input_len(), (unsigned)ai_engine_spoof_input_len(),
           (unsigned)ai_engine_recog_input_len());
    printf("arena_fast %u B of %u KB in %s\n", (unsigned)stats.fast_used_bytes,
           (unsigned)(stats.fast_bytes / 1024), stats.fast_internal ? "sram" : "psram");
    printf("arena_big  %u B of %u KB in psram\n", (unsigned)stats.big_used_bytes,
           (unsigned)(stats.big_bytes / 1024));
    printf("free after init: internal %u KB, psram %u KB\n",
           (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024),
           (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024));
}

TEST_CASE("one pass of all three, the number the budget is measured against", "[bench_ai]")
{
    const int64_t detect = time_runs(run_detect, "detect");
    const int64_t spoof = time_runs(run_spoof, "spoof");
    const int64_t recog = time_runs(run_recog, "recog");
    printf("one face end to end: %lld us\n", (long long)(detect + spoof + recog));
}

TEST_CASE("the same three under the psram traffic a preview makes", "[bench_ai]")
{
    s_load_running = true;
    s_load_frames = 0;
    const int64_t started = esp_timer_get_time();
    TEST_ASSERT_EQUAL(pdPASS, xTaskCreatePinnedToCore(psram_load_task, "load",
                                                      LOAD_TASK_STACK_BYTES, NULL,
                                                      LOAD_TASK_PRIORITY, NULL, LOAD_TASK_CORE));
    const int64_t detect = time_runs(run_detect, "detect");
    const int64_t spoof = time_runs(run_spoof, "spoof");
    const int64_t recog = time_runs(run_recog, "recog");
    const int64_t elapsed = esp_timer_get_time() - started;
    s_load_running = false;
    vTaskDelay(pdMS_TO_TICKS(2 * FRAME_PERIOD_MS));
    printf("under load: one face end to end %lld us\n", (long long)(detect + spoof + recog));
    const uint32_t moved_kb = (uint32_t)(((uint64_t)s_load_frames * FRAME_BYTES) / 1024U);
    printf("load moved %u frames, %u KB in %lld ms, %u KB/s of psram\n",
           (unsigned)s_load_frames, (unsigned)moved_kb, (long long)(elapsed / 1000),
           (unsigned)((uint64_t)moved_kb * 1000000U / (uint64_t)elapsed));
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
}
