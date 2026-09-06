#include <stdio.h>

#include "ai_engine.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "sys_storage.h"
#include "unity.h"

#define DETECT_LEN (120 * 160 * 3)
#define CROP_LEN (80 * 80 * 3)
#define FACE_LEN (112 * 112 * 3)
#define EMBED_MAX 512
#define RUNS 20

// These stand in for camera frames and crops, which live in psram on the real
// device; leaving them in bss would take the internal ram an arena wants.
static int8_t *s_frame;
static int8_t *s_tight;
static int8_t *s_wide;
static int8_t *s_face;
static int8_t s_embedding[EMBED_MAX];

static int8_t *psram(size_t len, int seed)
{
    int8_t *buffer = heap_caps_malloc(len, MALLOC_CAP_SPIRAM);
    TEST_ASSERT_NOT_NULL(buffer);
    for (size_t i = 0; i < len; ++i) {
        buffer[i] = (int8_t)(((i * 31) + (seed * 97)) % 255 - 128);
    }
    return buffer;
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
    s_frame = psram(DETECT_LEN, 1);
    s_tight = psram(CROP_LEN, 2);
    s_wide = psram(CROP_LEN, 3);
    s_face = psram(FACE_LEN, 4);

    ai_engine_arena_stats_t stats;
    ai_engine_arena_stats(&stats);
    TEST_ASSERT_EQUAL_UINT(DETECT_LEN, ai_engine_detect_input_len());
    TEST_ASSERT_EQUAL_UINT(CROP_LEN, ai_engine_spoof_input_len());
    TEST_ASSERT_EQUAL_UINT(FACE_LEN, ai_engine_recog_input_len());
    printf("arena_fast %u B of %u KB in %s\n", (unsigned)stats.fast_used,
           (unsigned)(stats.fast_bytes / 1024), stats.fast_internal ? "sram" : "psram");
    printf("arena_big  %u B of %u KB in psram\n", (unsigned)stats.big_used,
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

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
}
