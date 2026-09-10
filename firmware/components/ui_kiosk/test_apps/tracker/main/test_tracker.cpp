#include <math.h>
#include <stdint.h>
#include <stdio.h>

#include "box_tracker.hpp"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "unity.h"

namespace {

constexpr int kFrameW = 480;
constexpr int kFrameH = 320;
constexpr int kBlob = 60;
constexpr int kFrames = 10;
constexpr float kFollowTolerancePx = 2.0f;
constexpr int kStepX = 3;
constexpr int kStepY = 2;
constexpr int kFastStepX = 12;
constexpr int kJumpPx = 40;
constexpr int kRadiusPx = ui::BoxTracker::kRadius * ui::BoxTracker::kStep;
constexpr int kUpdateBudgetUs = 4000;

uint16_t *s_frame;

uint16_t grey565(unsigned level)
{
    const unsigned v5 = (level >> 3) & 0x1Fu;
    const unsigned v6 = (level >> 2) & 0x3Fu;
    return static_cast<uint16_t>((v5 << 11) | (v6 << 5) | v5);
}

// A blob whose texture rides with it, on a smooth background that gives no false match.
void paint(int blob_x, int blob_y)
{
    for (int y = 0; y < kFrameH; ++y) {
        for (int x = 0; x < kFrameW; ++x) {
            unsigned level = 60u + static_cast<unsigned>((x + y) / 16);
            const int dx = x - blob_x;
            const int dy = y - blob_y;
            if (dx >= 0 && dy >= 0 && dx < kBlob && dy < kBlob) {
                const unsigned hash = static_cast<unsigned>(dx * 73856093) ^ static_cast<unsigned>(dy * 19349663);
                level = 40u + ((hash >> 13) & 0xBFu);
            }
            s_frame[y * kFrameW + x] = grey565(level);
        }
    }
}

ui::Box blob_box(int blob_x, int blob_y)
{
    return { static_cast<float>(blob_x), static_cast<float>(blob_y), static_cast<float>(blob_x + kBlob),
             static_cast<float>(blob_y + kBlob) };
}

float centre_error(const ui::Box &box, int blob_x, int blob_y)
{
    const float cx = (box.x1 + box.x2) / 2.0f - (blob_x + kBlob / 2.0f);
    const float cy = (box.y1 + box.y2) / 2.0f - (blob_y + kBlob / 2.0f);
    return sqrtf(cx * cx + cy * cy);
}

}  // namespace

TEST_CASE("a textured patch drifting a few pixels a frame is followed", "[ui_kiosk]")
{
    s_frame = static_cast<uint16_t *>(heap_caps_malloc(kFrameW * kFrameH * sizeof(uint16_t), MALLOC_CAP_SPIRAM));
    TEST_ASSERT_NOT_NULL(s_frame);
    int bx = 200;
    int by = 120;
    paint(bx, by);
    ui::BoxTracker tracker;
    tracker.set(blob_box(bx, by), s_frame, kFrameW, kFrameH);
    TEST_ASSERT_TRUE(tracker.active());
    int64_t total_us = 0;
    float worst = 0.0f;
    for (int i = 0; i < kFrames; ++i) {
        bx += kStepX;
        by += kStepY;
        paint(bx, by);
        const int64_t t0 = esp_timer_get_time();
        TEST_ASSERT_TRUE(tracker.update(s_frame, kFrameW, kFrameH));
        total_us += esp_timer_get_time() - t0;
        const float err = centre_error(tracker.box(), bx, by);
        worst = err > worst ? err : worst;
    }
    printf("update %lld us average, worst centre error %.1f px over %d frames\n", total_us / kFrames, worst, kFrames);
    TEST_ASSERT_TRUE(worst <= kFollowTolerancePx);
    TEST_ASSERT_LESS_THAN(kUpdateBudgetUs, (int)(total_us / kFrames));
}

TEST_CASE("a fast walk inside the search radius is still followed", "[ui_kiosk]")
{
    int bx = 100;
    int by = 150;
    paint(bx, by);
    ui::BoxTracker tracker;
    tracker.set(blob_box(bx, by), s_frame, kFrameW, kFrameH);
    for (int i = 0; i < kFrames; ++i) {
        bx += kFastStepX;
        paint(bx, by);
        TEST_ASSERT_TRUE(tracker.update(s_frame, kFrameW, kFrameH));
        TEST_ASSERT_TRUE(centre_error(tracker.box(), bx, by) <= kFollowTolerancePx);
    }
}

TEST_CASE("a jump past the radius does not drag the box along", "[ui_kiosk]")
{
    const int bx = 200;
    const int by = 120;
    paint(bx, by);
    ui::BoxTracker tracker;
    tracker.set(blob_box(bx, by), s_frame, kFrameW, kFrameH);
    paint(bx + kJumpPx, by);
    const ui::Box before = tracker.box();
    tracker.update(s_frame, kFrameW, kFrameH);
    const float moved = fabsf(tracker.box().x1 - before.x1) + fabsf(tracker.box().y1 - before.y1);
    printf("after a %d px jump the box moved %.0f px\n", kJumpPx, moved);
    TEST_ASSERT_TRUE(moved <= kRadiusPx);
}

TEST_CASE("a flat patch is refused at set and never moves", "[ui_kiosk]")
{
    for (int i = 0; i < kFrameW * kFrameH; ++i) {
        s_frame[i] = grey565(128);
    }
    ui::BoxTracker tracker;
    tracker.set(blob_box(200, 120), s_frame, kFrameW, kFrameH);
    TEST_ASSERT_FALSE(tracker.active());
    TEST_ASSERT_FALSE(tracker.update(s_frame, kFrameW, kFrameH));
}

TEST_CASE("a fresh detector box replaces the tracked one, and the frame edge is safe", "[ui_kiosk]")
{
    int bx = 200;
    int by = 120;
    paint(bx, by);
    ui::BoxTracker tracker;
    tracker.set(blob_box(bx, by), s_frame, kFrameW, kFrameH);
    bx += kStepX;
    paint(bx, by);
    tracker.update(s_frame, kFrameW, kFrameH);
    // The detector's box wins over whatever the tracker believed.
    bx = kFrameW - kBlob - 4;
    by = kFrameH - kBlob - 4;
    paint(bx, by);
    tracker.set(blob_box(bx, by), s_frame, kFrameW, kFrameH);
    TEST_ASSERT_TRUE(tracker.active());
    TEST_ASSERT_FLOAT_WITHIN(0.01f, static_cast<float>(bx), tracker.box().x1);
    for (int i = 0; i < 3; ++i) {
        bx -= kStepX;
        paint(bx, by);
        TEST_ASSERT_TRUE(tracker.update(s_frame, kFrameW, kFrameH));
        TEST_ASSERT_TRUE(centre_error(tracker.box(), bx, by) <= kFollowTolerancePx);
    }
}

extern "C" void app_main(void)
{
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
