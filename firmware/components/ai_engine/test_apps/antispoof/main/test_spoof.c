#include <string.h>

#include "ai_engine.h"
#include "esp_heap_caps.h"
#include "sys_storage.h"
#include "unity.h"

#define CHANNELS 3

// Crops live in psram: in bss they would take the internal ram an arena wants,
// and the measurement would be of a chip the test itself narrowed.
static int8_t *s_tight;
static int8_t *s_wide;
static size_t s_len;

static int8_t *fill(size_t len, int seed)
{
    int8_t *crop = heap_caps_malloc(len, MALLOC_CAP_SPIRAM);
    TEST_ASSERT_NOT_NULL(crop);
    for (size_t i = 0; i < len; ++i) {
        crop[i] = (int8_t)(((i * 31) + (seed * 97)) % 255 - 128);
    }
    return crop;
}

static size_t square_side(size_t len)
{
    TEST_ASSERT_EQUAL_UINT(0, len % CHANNELS);
    size_t side = 1;
    while (side * side * CHANNELS < len) {
        ++side;
    }
    TEST_ASSERT_EQUAL_UINT(len, side * side * CHANNELS);
    return side;
}

TEST_CASE("the branch comes up and reports where its arena landed", "[ai_spoof]")
{
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_init());
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_init());

    ai_engine_arena_stats_t stats;
    ai_engine_arena_stats(&stats);
    TEST_ASSERT_GREATER_THAN_UINT(0, stats.fast_used);

    // The crop side belongs to the graph, which picks it so every feature map
    // stays odd (KEHOACH 3 layer 1); pinning it here would pin two places.
    s_len = ai_engine_spoof_input_len();
    const size_t side = square_side(s_len);
    printf("spoof input %u B, a square %ux%u RGB crop\n", (unsigned)s_len, (unsigned)side,
           (unsigned)side);
    printf("arena_fast %u B used of %u KB in %s, internal free %u KB, psram free %u KB\n",
           (unsigned)stats.fast_used, (unsigned)(stats.fast_bytes / 1024),
           stats.fast_internal ? "sram" : "psram",
           (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024),
           (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024));
}

TEST_CASE("a crop pair comes back as a probability", "[ai_spoof]")
{
    s_tight = fill(s_len, 1);
    s_wide = fill(s_len, 2);
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
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_spoof(s_tight, s_wide, &first));
    memset(s_tight, -128, s_len);
    memset(s_wide, 127, s_len);
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
