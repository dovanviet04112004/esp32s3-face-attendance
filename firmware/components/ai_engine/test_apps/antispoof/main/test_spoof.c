#include <string.h>

#include "ai_engine.h"
#include "esp_heap_caps.h"
#include "sdkconfig.h"
#include "sys_storage.h"
#include "unity.h"

#define CHANNELS 3

// Crops live in psram: in bss they would take the internal ram an arena wants,
// and the measurement would be of a chip the test itself narrowed.
static int8_t *s_face;
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
#if CONFIG_AI_RUNTIME_TFLM
    TEST_ASSERT_GREATER_THAN_UINT(0, stats.big_used_bytes);
#endif

    // The crop side belongs to the graph, which picks it so every feature map
    // stays odd (KEHOACH 3 layer 1); pinning it here would pin two places.
    s_len = ai_engine_spoof_input_bytes();
    if (s_len == 0) {
        TEST_IGNORE_MESSAGE("the image on models_0 carries no spoof branch (KEHOACH 6.2.2)");
    }
    const size_t side = square_side(s_len);
    printf("spoof input %u B, a square %ux%u RGB crop\n", (unsigned)s_len, (unsigned)side,
           (unsigned)side);
    printf("arena_big %u B used of %u KB, internal free %u KB, psram free %u KB\n",
           (unsigned)stats.big_used_bytes, (unsigned)(stats.big_bytes / 1024),
           (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024),
           (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024));
}

static void need_branch(void)
{
    if (s_len == 0) {
        TEST_IGNORE_MESSAGE("no spoof branch on models_0");
    }
}

TEST_CASE("a face crop comes back as a probability", "[ai_spoof]")
{
    need_branch();
    s_face = fill(s_len, 1);
    float live = -1.0F;
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_spoof(s_face, &live));
    TEST_ASSERT_TRUE(live >= 0.0F && live <= 1.0F);
    printf("live %.4f\n", live);
}

TEST_CASE("the crop reaches the graph rather than a zeroed tensor", "[ai_spoof]")
{
    need_branch();
    // Two runs that differ only in their input must differ in their answer,
    // which is what a crop landing in the wrong tensor would not do.
    float first = 0.0F, second = 0.0F;
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_spoof(s_face, &first));
    memset(s_face, -128, s_len);
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_spoof(s_face, &second));
    printf("live %.4f then %.4f\n", first, second);
    TEST_ASSERT_NOT_EQUAL_FLOAT(first, second);
}

#define FRAME_W 480
#define FRAME_H 320
#define CENTRED_FACE_PX 100.0f

static uint16_t *gradient_frame(void)
{
    uint16_t *pixels = heap_caps_malloc(FRAME_W * FRAME_H * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    TEST_ASSERT_NOT_NULL(pixels);
    for (int y = 0; y < FRAME_H; ++y) {
        for (int x = 0; x < FRAME_W; ++x) {
            pixels[y * FRAME_W + x] = (uint16_t)(((x >> 4) << 11) | ((y >> 3) << 5) | ((x + y) >> 5 & 0x1F));
        }
    }
    return pixels;
}

static void centred_box(float face_px, float box[4])
{
    box[0] = FRAME_W / 2.0f - face_px / 2.0f;
    box[1] = FRAME_H / 2.0f - face_px / 2.0f;
    box[2] = box[0] + face_px;
    box[3] = box[1] + face_px;
}

TEST_CASE("a crop cut from a frame scores, and a face taller than the frame still fits", "[ai_spoof]")
{
    need_branch();
    const ai_engine_frame_t frame = { .pixels = gradient_frame(), .width = FRAME_W, .height = FRAME_H };
    float box[4];
    float live = -1.0f;
    centred_box(CENTRED_FACE_PX, box);
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_spoof_face(&frame, box, &live));
    TEST_ASSERT_TRUE(live >= 0.0f && live <= 1.0f);
    printf("100 px face: live %.4f\n", live);
    // Taller than the 320 px frame: the square shrinks to the frame rather than failing.
    centred_box(FRAME_H + 40.0f, box);
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_spoof_face(&frame, box, &live));
    TEST_ASSERT_TRUE(live >= 0.0f && live <= 1.0f);
    printf("360 px face: live %.4f\n", live);
    const float flat[4] = { 10.0f, 10.0f, 10.0f, 50.0f };
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, ai_engine_spoof_face(&frame, flat, &live));
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
}
