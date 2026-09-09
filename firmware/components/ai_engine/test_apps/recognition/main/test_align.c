#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "ai_engine.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "sys_storage.h"
#include "unity.h"

#define FRAME_W 480
#define FRAME_H 320
#define EMBED_DIM 512
#define LANDMARKS 10
#define FACE_SCALE 2.0f
#define FACE_LEFT 100.0f
#define FACE_TOP 40.0f
#define SHIFT_PX 60.0f
#define UNIT_TOLERANCE 0.02f

// ArcFace's reference points on the 112 grid (align.py), placed in the frame by a similarity.
static const float k_reference[LANDMARKS] = { 38.2946f, 51.6963f, 73.5318f, 51.5014f, 56.0252f,
                                              71.7366f, 41.5493f, 92.3655f, 70.7299f, 92.2041f };

static uint16_t *s_pixels;
static int8_t s_first[EMBED_DIM];
static int8_t s_second[EMBED_DIM];

static void frame_landmarks(float shift_x, float out[LANDMARKS])
{
    for (int i = 0; i < LANDMARKS; ++i) {
        out[i] = k_reference[i] * FACE_SCALE + ((i % 2 == 0) ? FACE_LEFT + shift_x : FACE_TOP);
    }
}

static float length_of(const int8_t *emb, float scale)
{
    double sum = 0.0;
    for (int i = 0; i < EMBED_DIM; ++i) {
        const double v = emb[i] * (double)scale;
        sum += v * v;
    }
    return (float)sqrt(sum);
}

TEST_CASE("the recogniser loads and a frame is ready for it", "[ai_recog]")
{
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_init());
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_init());
    TEST_ASSERT_EQUAL(EMBED_DIM, ai_engine_recog_output_bytes());
    s_pixels = heap_caps_malloc(FRAME_W * FRAME_H * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    TEST_ASSERT_NOT_NULL(s_pixels);
    for (int y = 0; y < FRAME_H; ++y) {
        for (int x = 0; x < FRAME_W; ++x) {
            s_pixels[y * FRAME_W + x] = (uint16_t)(((x >> 4) << 11) | ((y >> 3) << 5) | ((x * 7 + y * 3) >> 4 & 0x1F));
        }
    }
}

TEST_CASE("an aligned face embeds to a unit vector", "[ai_recog]")
{
    const ai_engine_frame_t frame = { .pixels = s_pixels, .width = FRAME_W, .height = FRAME_H };
    float landmarks[LANDMARKS];
    float scale = 0.0f;
    frame_landmarks(0.0f, landmarks);
    const int64_t t0 = esp_timer_get_time();
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_recognize_face(&frame, landmarks, s_first, sizeof(s_first), &scale));
    const int64_t took_us = esp_timer_get_time() - t0;
    TEST_ASSERT_TRUE(scale > 0.0f);
    const float length = length_of(s_first, scale);
    printf("align + recog %lld us, scale %.6f, length %.4f\n", took_us, scale, length);
    TEST_ASSERT_FLOAT_WITHIN(UNIT_TOLERANCE, 1.0f, length);
}

TEST_CASE("moving the landmarks moves the embedding", "[ai_recog]")
{
    const ai_engine_frame_t frame = { .pixels = s_pixels, .width = FRAME_W, .height = FRAME_H };
    float landmarks[LANDMARKS];
    float scale = 0.0f;
    frame_landmarks(SHIFT_PX, landmarks);
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_recognize_face(&frame, landmarks, s_second, sizeof(s_second), &scale));
    TEST_ASSERT_TRUE(memcmp(s_first, s_second, sizeof(s_first)) != 0);
}

TEST_CASE("landmarks collapsed to one point are refused", "[ai_recog]")
{
    const ai_engine_frame_t frame = { .pixels = s_pixels, .width = FRAME_W, .height = FRAME_H };
    float landmarks[LANDMARKS];
    float scale = 0.0f;
    for (int i = 0; i < LANDMARKS; ++i) {
        landmarks[i] = 100.0f;
    }
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, ai_engine_recognize_face(&frame, landmarks, s_first, sizeof(s_first), &scale));
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
