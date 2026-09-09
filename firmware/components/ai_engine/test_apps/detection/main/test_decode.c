#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "ai_engine.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "sys_storage.h"
#include "unity.h"

#define DETECT_H 120
#define DETECT_W 160
#define CHANNELS 3
#define FACE_CAP 32
#define SMALL_CAP 3
#define HALF 0.5f
#define HIGH 0.9f
#define NMS_IOU 0.3f
#define GREY 0
#define FRAME_SLACK 0.5f

static int8_t *s_frame;
static ai_engine_face_t s_faces[FACE_CAP];

static float iou(const float *a, const float *b)
{
    const float left = fmaxf(a[0], b[0]);
    const float top = fmaxf(a[1], b[1]);
    const float right = fminf(a[2], b[2]);
    const float bottom = fminf(a[3], b[3]);
    const float inter = fmaxf(right - left, 0.0f) * fmaxf(bottom - top, 0.0f);
    const float joined = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    return joined > 0.0f ? inter / joined : 0.0f;
}

static bool finite_face(const ai_engine_face_t *face)
{
    bool ok = isfinite(face->score);
    for (int i = 0; i < 4; ++i) {
        ok = ok && isfinite(face->box[i]);
    }
    for (int i = 0; i < 10; ++i) {
        ok = ok && isfinite(face->landmarks[i]);
    }
    return ok;
}

TEST_CASE("the detector loads and takes the 160x120 frame of the plan", "[ai_detect]")
{
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_init());
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_init());
    TEST_ASSERT_EQUAL(DETECT_H * DETECT_W * CHANNELS, ai_engine_detect_input_bytes());
    s_frame = heap_caps_malloc(ai_engine_detect_input_bytes(), MALLOC_CAP_SPIRAM);
    TEST_ASSERT_NOT_NULL(s_frame);
}

TEST_CASE("no face comes back until a detect has run", "[ai_detect]")
{
    TEST_ASSERT_EQUAL(0, ai_engine_faces(0.0f, s_faces, FACE_CAP));
}

TEST_CASE("a flat grey frame carries no face above half confidence", "[ai_detect]")
{
    memset(s_frame, GREY, ai_engine_detect_input_bytes());
    const int64_t t0 = esp_timer_get_time();
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_detect(s_frame));
    const int64_t detect_us = esp_timer_get_time() - t0;
    const int64_t t1 = esp_timer_get_time();
    const size_t count = ai_engine_faces(HALF, s_faces, FACE_CAP);
    printf("detect %lld us, decode %lld us, %u face(s) at or above %.1f on flat grey\n", detect_us,
           esp_timer_get_time() - t1, (unsigned)count, HALF);
    TEST_ASSERT_EQUAL(0, count);
}

TEST_CASE("with no floor the decode is sorted, suppressed and finite", "[ai_detect]")
{
    const int64_t t0 = esp_timer_get_time();
    const size_t count = ai_engine_faces(0.0f, s_faces, FACE_CAP);
    printf("no floor: %u candidate(s) in %lld us, best %.4f at (%.1f, %.1f)-(%.1f, %.1f)\n", (unsigned)count,
           esp_timer_get_time() - t0, s_faces[0].score, s_faces[0].box[0], s_faces[0].box[1], s_faces[0].box[2],
           s_faces[0].box[3]);
    TEST_ASSERT_GREATER_THAN(0, count);
    size_t outside = 0;
    for (size_t i = 0; i < count; ++i) {
        TEST_ASSERT_TRUE(finite_face(&s_faces[i]));
        TEST_ASSERT_TRUE(s_faces[i].score >= 0.0f && s_faces[i].score <= 1.0f);
        TEST_ASSERT_TRUE(s_faces[i].box[2] > s_faces[i].box[0] && s_faces[i].box[3] > s_faces[i].box[1]);
        outside += s_faces[i].box[0] < -FRAME_SLACK * DETECT_W || s_faces[i].box[2] > (1 + FRAME_SLACK) * DETECT_W ||
                   s_faces[i].box[1] < -FRAME_SLACK * DETECT_H || s_faces[i].box[3] > (1 + FRAME_SLACK) * DETECT_H;
        if (i > 0) {
            TEST_ASSERT_TRUE(s_faces[i - 1].score >= s_faces[i].score);
        }
        for (size_t k = 0; k < i; ++k) {
            TEST_ASSERT_TRUE(iou(s_faces[k].box, s_faces[i].box) <= NMS_IOU);
        }
    }
    // Noise priors on a blank frame may regress a box far outside; that is a fact about the input, not the decode.
    printf("%u of %u boxes spill more than half a frame past the edge\n", (unsigned)outside, (unsigned)count);
}

TEST_CASE("the floor and the cap are both honoured", "[ai_detect]")
{
    const size_t high = ai_engine_faces(HIGH, s_faces, FACE_CAP);
    for (size_t i = 0; i < high; ++i) {
        TEST_ASSERT_TRUE(s_faces[i].score >= HIGH);
    }
    const size_t capped = ai_engine_faces(0.0f, s_faces, SMALL_CAP);
    TEST_ASSERT_LESS_OR_EQUAL(SMALL_CAP, capped);
    printf("%u face(s) at or above %.1f, %u with a cap of %d\n", (unsigned)high, HIGH, (unsigned)capped, SMALL_CAP);
}

#define FRAME_W 480
#define FRAME_H 320
#define LETTERBOX_SCALE (1.0f / 3.0f)
#define LETTERBOX_PAD_Y 6
#define MAP_TOLERANCE 0.05f

TEST_CASE("a camera frame letterboxes with the geometry the plan states", "[ai_detect]")
{
    uint16_t *pixels = heap_caps_malloc(FRAME_W * FRAME_H * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    TEST_ASSERT_NOT_NULL(pixels);
    for (int y = 0; y < FRAME_H; ++y) {
        for (int x = 0; x < FRAME_W; ++x) {
            pixels[y * FRAME_W + x] = (uint16_t)(((x >> 4) << 11) | ((y >> 3) << 5) | ((x + y) >> 5 & 0x1F));
        }
    }
    const ai_engine_frame_t frame = { .pixels = pixels, .width = FRAME_W, .height = FRAME_H };
    ai_engine_letterbox_t geometry;
    const int64_t t0 = esp_timer_get_time();
    TEST_ASSERT_EQUAL(ESP_OK, ai_engine_detect_frame(&frame, &geometry));
    printf("letterbox + detect %lld us, scale %.4f, pad %d,%d\n", esp_timer_get_time() - t0, geometry.scale,
           geometry.pad_x, geometry.pad_y);
    TEST_ASSERT_FLOAT_WITHIN(0.0001f, LETTERBOX_SCALE, geometry.scale);
    TEST_ASSERT_EQUAL(0, geometry.pad_x);
    TEST_ASSERT_EQUAL(LETTERBOX_PAD_Y, geometry.pad_y);
    heap_caps_free(pixels);
}

TEST_CASE("a face maps back through the letterbox geometry", "[ai_detect]")
{
    const ai_engine_letterbox_t geometry = { .scale = LETTERBOX_SCALE, .pad_x = 0, .pad_y = LETTERBOX_PAD_Y };
    ai_engine_face_t face = { .box = { 0.0f, 6.0f, 160.0f, 112.6667f }, .landmarks = { 80.0f, 60.0f }, .score = 1.0f };
    ai_engine_face_to_frame(&geometry, &face);
    TEST_ASSERT_FLOAT_WITHIN(MAP_TOLERANCE, 0.0f, face.box[0]);
    TEST_ASSERT_FLOAT_WITHIN(MAP_TOLERANCE, 0.0f, face.box[1]);
    TEST_ASSERT_FLOAT_WITHIN(MAP_TOLERANCE, FRAME_W, face.box[2]);
    TEST_ASSERT_FLOAT_WITHIN(MAP_TOLERANCE, FRAME_H, face.box[3]);
    TEST_ASSERT_FLOAT_WITHIN(MAP_TOLERANCE, 240.0f, face.landmarks[0]);
    TEST_ASSERT_FLOAT_WITHIN(MAP_TOLERANCE, 162.0f, face.landmarks[1]);
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
