#include <string.h>

#include "ai_engine.h"
#include "esp_heap_caps.h"
#include "sys_storage.h"
#include "unity.h"

#define CROP_SIDE 80
#define CROP_LEN (CROP_SIDE * CROP_SIDE * 3)

static int8_t s_tight[CROP_LEN];
static int8_t s_wide[CROP_LEN];

static void fill(int8_t *crop, int seed)
{
    for (int i = 0; i < CROP_LEN; ++i) {
        crop[i] = (int8_t)(((i * 31) + (seed * 97)) % 255 - 128);
    }
}

TEST_CASE("the branch comes up and reports where its arena landed", "[ai_spoof]")
{
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_init());
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_init());

    ai_engine_arena_stats_t stats;
    ai_engine_arena_stats(&stats);
    TEST_ASSERT_GREATER_THAN_UINT(0, stats.fast_used);
    TEST_ASSERT_EQUAL_UINT(CROP_LEN, ai_engine_spoof_input_len());
    printf("arena_fast %u B used of %u KB in %s, internal free %u KB, psram free %u KB\n",
           (unsigned)stats.fast_used, (unsigned)(stats.fast_bytes / 1024),
           stats.fast_internal ? "sram" : "psram",
           (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024),
           (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024));
}

TEST_CASE("a crop pair comes back as a probability", "[ai_spoof]")
{
    fill(s_tight, 1);
    fill(s_wide, 2);
    float live = -1.0F;
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_spoof(s_tight, s_wide, &live));
    TEST_ASSERT_TRUE(live >= 0.0F && live <= 1.0F);
    printf("live %.4f\n", live);
}

TEST_CASE("the crops reach the graph rather than a zeroed tensor", "[ai_spoof]")
{
    // Two runs that differ only in their input must differ in their answer,
    // which is what a crop landing in the wrong tensor would not do.
    float first = 0.0F, second = 0.0F;
    fill(s_tight, 3);
    fill(s_wide, 4);
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_spoof(s_tight, s_wide, &first));
    memset(s_tight, -128, sizeof(s_tight));
    memset(s_wide, 127, sizeof(s_wide));
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_spoof(s_tight, s_wide, &second));
    printf("live %.4f then %.4f\n", first, second);
    TEST_ASSERT_NOT_EQUAL_FLOAT(first, second);
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
}
