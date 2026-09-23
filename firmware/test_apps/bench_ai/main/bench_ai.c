#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ai_engine.h"
#include "esp_crc.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sys_storage.h"
#include "unity.h"

#define WARMUP_RUNS 3
#define RUNS 50
#define P95_RANK ((RUNS * 95 + 99) / 100)
#define HASH_FACES_CAP 32

_Static_assert(RUNS % 2 == 0, "the median below averages the two middle samples");

// One RGB565 frame at the sensor's own size, and the rate cam_task delivers
// them, so the load below moves what the preview really moves (KEHOACH 5.1).
#define FRAME_BYTES (480 * 320 * 2)
#define FRAME_PERIOD_MS 70
#define LOAD_TASK_CORE 0
#define LOAD_TASK_PRIORITY 7
#define LOAD_TASK_STACK_BYTES 3072

static const char *const BRANCHES[] = {"detect", "spoof", "recog"};
#define BRANCH_COUNT (sizeof(BRANCHES) / sizeof(BRANCHES[0]))

// Camera frames live in psram on the real device, and in bss these would take
// the internal ram an arena wants. Sizes come from the graphs themselves.
static int8_t *s_frame;
static int8_t *s_spoof_face;
static int8_t *s_recog_face;
static int8_t *s_embedding;

static int64_t s_samples[BRANCH_COUNT + 1][RUNS];

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
static int64_t s_load_started_us;

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

static void load_start(void)
{
    s_load_running = true;
    s_load_frames = 0;
    s_load_started_us = esp_timer_get_time();
    TEST_ASSERT_EQUAL(pdPASS, xTaskCreatePinnedToCore(psram_load_task, "load",
                                                      LOAD_TASK_STACK_BYTES, NULL,
                                                      LOAD_TASK_PRIORITY, NULL, LOAD_TASK_CORE));
}

static void load_stop(void)
{
    const int64_t elapsed = esp_timer_get_time() - s_load_started_us;
    s_load_running = false;
    vTaskDelay(pdMS_TO_TICKS(2 * FRAME_PERIOD_MS));
    const uint32_t moved_kb = (uint32_t)(((uint64_t)s_load_frames * FRAME_BYTES) / 1024U);
    printf("load moved %u frames, %u KB in %lld ms, %u KB/s of psram\n",
           (unsigned)s_load_frames, (unsigned)moved_kb, (long long)(elapsed / 1000),
           (unsigned)((uint64_t)moved_kb * 1000000U / (uint64_t)elapsed));
}

static esp_err_t run_detect(void)
{
    return ai_engine_detect(s_frame);
}

static esp_err_t run_spoof(void)
{
    float live = 0.0F;
    return ai_engine_spoof(s_spoof_face, &live);
}

static esp_err_t run_recog(void)
{
    float scale = 0.0F;
    return ai_engine_recognize(s_recog_face, s_embedding, ai_engine_recog_output_bytes(), &scale);
}

static esp_err_t (*const RUN[BRANCH_COUNT])(void) = {run_detect, run_spoof, run_recog};

static int by_value(const void *a, const void *b)
{
    const int64_t left = *(const int64_t *)a;
    const int64_t right = *(const int64_t *)b;
    return (left > right) - (left < right);
}

// Sorts the samples in place: their run order is gone once this returns.
static int64_t report(const char *label, int64_t *samples)
{
    int64_t total = 0;
    for (int i = 0; i < RUNS; ++i) {
        total += samples[i];
    }
    qsort(samples, RUNS, sizeof(samples[0]), by_value);
    const int64_t median = (samples[RUNS / 2 - 1] + samples[RUNS / 2]) / 2;
    printf("%-7s median %8lld us  p95 %8lld us  min %8lld us  max %8lld us  mean %8lld us\n",
           label, (long long)median, (long long)samples[P95_RANK - 1], (long long)samples[0],
           (long long)samples[RUNS - 1], (long long)(total / RUNS));
    return median;
}

static int64_t time_once(esp_err_t (*once)(void))
{
    const int64_t started = esp_timer_get_time();
    TEST_ASSERT_EQUAL(ESP_OK, once());
    return esp_timer_get_time() - started;
}

static void time_each_branch(const char *when)
{
    int64_t pass = 0;
    for (size_t branch = 0; branch < BRANCH_COUNT; ++branch) {
        for (int i = 0; i < WARMUP_RUNS; ++i) {
            (void)time_once(RUN[branch]);
        }
        for (int i = 0; i < RUNS; ++i) {
            s_samples[branch][i] = time_once(RUN[branch]);
        }
        pass += report(BRANCHES[branch], s_samples[branch]);
    }
    printf("%s, each branch alone: one face end to end %lld us\n", when, (long long)pass);
}

// Detect, spoof, recog back to back: the order and cache state ai_task sees.
static void time_interleaved(const char *when)
{
    for (int i = 0; i < WARMUP_RUNS + RUNS; ++i) {
        int64_t pass = 0;
        for (size_t branch = 0; branch < BRANCH_COUNT; ++branch) {
            const int64_t spent = time_once(RUN[branch]);
            pass += spent;
            if (i >= WARMUP_RUNS) {
                s_samples[branch][i - WARMUP_RUNS] = spent;
            }
        }
        if (i >= WARMUP_RUNS) {
            s_samples[BRANCH_COUNT][i - WARMUP_RUNS] = pass;
        }
    }
    printf("%s, interleaved:\n", when);
    for (size_t branch = 0; branch < BRANCH_COUNT; ++branch) {
        (void)report(BRANCHES[branch], s_samples[branch]);
    }
    (void)report("pass", s_samples[BRANCH_COUNT]);
}

TEST_CASE("all three branches load and report what they took", "[bench_ai]")
{
    const esp_err_t up = sys_storage_init();
    TEST_ASSERT_TRUE(up == ESP_OK || up == ESP_ERR_INVALID_STATE);
    const size_t internal_before = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    const size_t psram_before = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    const int64_t started = esp_timer_get_time();
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_init());
    printf("init %lld ms, took internal %u KB and psram %u KB\n", (long long)((esp_timer_get_time() - started) / 1000),
           (unsigned)((internal_before - heap_caps_get_free_size(MALLOC_CAP_INTERNAL)) / 1024),
           (unsigned)((psram_before - heap_caps_get_free_size(MALLOC_CAP_SPIRAM)) / 1024));
    s_frame = psram(ai_engine_detect_input_bytes(), 1);
    s_spoof_face = psram(ai_engine_spoof_input_bytes(), 2);
    s_recog_face = psram(ai_engine_recog_input_bytes(), 4);
    s_embedding = psram(ai_engine_recog_output_bytes(), 5);

    ai_engine_arena_stats_t stats;
    ai_engine_arena_stats(&stats);
    printf("inputs: detect %u B, spoof %u B, recog %u B\n",
           (unsigned)ai_engine_detect_input_bytes(), (unsigned)ai_engine_spoof_input_bytes(),
           (unsigned)ai_engine_recog_input_bytes());
    printf("arena_fast %u B of %u KB in %s\n", (unsigned)stats.fast_used_bytes,
           (unsigned)(stats.fast_bytes / 1024), stats.fast_internal ? "sram" : "psram");
    printf("arena_big  %u B of %u KB in psram\n", (unsigned)stats.big_used_bytes,
           (unsigned)(stats.big_bytes / 1024));
    printf("free after init: internal %u KB, psram %u KB, largest psram block %u KB\n",
           (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024),
           (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024),
           (unsigned)(heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM) / 1024));
}

TEST_CASE("the outputs two builds must agree on to the bit", "[bench_ai]")
{
    static ai_engine_face_t faces[HASH_FACES_CAP];
    TEST_ASSERT_EQUAL(ESP_OK, run_detect());
    const size_t found = ai_engine_faces(0.0F, faces, HASH_FACES_CAP);
    const uint32_t detect = esp_crc32_le(0, (const uint8_t *)faces, (uint32_t)(found * sizeof(faces[0])));

    float live = 0.0F;
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_spoof(s_spoof_face, &live));
    const uint32_t spoof = esp_crc32_le(0, (const uint8_t *)&live, sizeof(live));

    float scale = 0.0F;
    const size_t embedding_bytes = ai_engine_recog_output_bytes();
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_recognize(s_recog_face, s_embedding, embedding_bytes, &scale));
    uint32_t recog = esp_crc32_le(0, (const uint8_t *)s_embedding, (uint32_t)embedding_bytes);
    recog = esp_crc32_le(recog, (const uint8_t *)&scale, sizeof(scale));

    printf("hash detect %08" PRIx32 " (%u faces)  spoof %08" PRIx32 " (live %.6f)  recog %08" PRIx32 "\n",
           detect, (unsigned)found, spoof, (double)live, recog);
}

TEST_CASE("each branch alone, the number the budget is measured against", "[bench_ai]")
{
    time_each_branch("idle");
}

TEST_CASE("each branch alone under the psram traffic a preview makes", "[bench_ai]")
{
    load_start();
    time_each_branch("under load");
    load_stop();
}

TEST_CASE("one face through all three in the order ai_task runs them", "[bench_ai]")
{
    time_interleaved("idle");
}

TEST_CASE("the same interleaved pass under preview traffic", "[bench_ai]")
{
    load_start();
    time_interleaved("under load");
    load_stop();
}

// A runtime that allocates per invoke would leak or fragment over a day of frames (KEHOACH 4.1).
TEST_CASE("the heap stays where it was across fifty passes", "[bench_ai]")
{
    TEST_ASSERT_EQUAL(ESP_OK, run_detect());
    const size_t internal = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    const size_t spiram = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    for (int i = 0; i < RUNS; ++i) {
        for (size_t branch = 0; branch < BRANCH_COUNT; ++branch) {
            TEST_ASSERT_EQUAL(ESP_OK, RUN[branch]());
        }
    }
    printf("after %d passes: internal %d B, psram %d B against the first pass\n", RUNS,
           (int)heap_caps_get_free_size(MALLOC_CAP_INTERNAL) - (int)internal,
           (int)heap_caps_get_free_size(MALLOC_CAP_SPIRAM) - (int)spiram);
    TEST_ASSERT_EQUAL(internal, heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    TEST_ASSERT_EQUAL(spiram, heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}

TEST_CASE("what copying the weights to psram and one crc32 over them cost", "[bench_ai]")
{
    const void *data[BRANCH_COUNT];
    size_t size[BRANCH_COUNT];
    size_t total = 0;
    for (size_t branch = 0; branch < BRANCH_COUNT; ++branch) {
        TEST_ASSERT_EQUAL(ESP_OK, sys_storage_model_find(BRANCHES[branch], &data[branch], &size[branch], NULL));
        total += size[branch];
    }
    uint8_t *copy = heap_caps_malloc(total, MALLOC_CAP_SPIRAM);
    TEST_ASSERT_NOT_NULL(copy);

    const int64_t copy_started = esp_timer_get_time();
    size_t at = 0;
    for (size_t branch = 0; branch < BRANCH_COUNT; ++branch) {
        memcpy(copy + at, data[branch], size[branch]);
        at += size[branch];
    }
    const int64_t copy_us = esp_timer_get_time() - copy_started;

    const int64_t crc_started = esp_timer_get_time();
    const uint32_t crc = esp_crc32_le(0, copy, (uint32_t)total);
    const int64_t crc_us = esp_timer_get_time() - crc_started;

    printf("weights %u KB: copy from flash %lld us, crc32 over the psram copy %lld us (%08" PRIx32 ")\n",
           (unsigned)(total / 1024), (long long)copy_us, (long long)crc_us, crc);
    heap_caps_free(copy);
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
}
