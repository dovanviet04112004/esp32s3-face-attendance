#include "box_tracker.hpp"

#include <math.h>
#include <stdlib.h>

namespace ui {

namespace {

constexpr int kMinContrast = 24;
constexpr uint32_t kLostMeanDiff = 48;
constexpr int kPatchPx = BoxTracker::kPatch * BoxTracker::kStep;
constexpr int kWindowPx = BoxTracker::kWindow * BoxTracker::kStep;
constexpr int kPositions = BoxTracker::kWindow - BoxTracker::kPatch + 1;

uint8_t luma(uint16_t rgb565) noexcept
{
    const unsigned r = (rgb565 >> 11) & 0x1Fu;
    const unsigned g = (rgb565 >> 5) & 0x3Fu;
    const unsigned b = rgb565 & 0x1Fu;
    const unsigned r8 = (r << 3) | (r >> 2);
    const unsigned g8 = (g << 2) | (g >> 4);
    const unsigned b8 = (b << 3) | (b >> 2);
    return static_cast<uint8_t>((r8 * 77u + g8 * 150u + b8 * 29u) >> 8);
}

int clamp(int value, int low, int high) noexcept
{
    return value < low ? low : (value > high ? high : value);
}

int centred(float centre, int side_px, int limit) noexcept
{
    return clamp(static_cast<int>(lroundf(centre - side_px / 2.0f)), 0, limit - side_px);
}

}  // namespace

void BoxTracker::sample(const uint16_t *frame, int width, int left, int top, int side, uint8_t *out) const noexcept
{
    for (int row = 0; row < side; ++row) {
        const uint16_t *line = frame + (top + row * kStep) * width + left;
        for (int col = 0; col < side; ++col) {
            *out++ = luma(line[col * kStep]);
        }
    }
}

uint32_t BoxTracker::sad(int col, int row) const noexcept
{
    uint32_t total = 0;
    for (int y = 0; y < kPatch; ++y) {
        const uint8_t *a = template_ + y * kPatch;
        const uint8_t *b = window_ + (row + y) * kWindow + col;
        for (int x = 0; x < kPatch; ++x) {
            total += static_cast<uint32_t>(abs(static_cast<int>(a[x]) - static_cast<int>(b[x])));
        }
    }
    return total;
}

void BoxTracker::set(const Box &box, const uint16_t *frame, int width, int height) noexcept
{
    active_ = false;
    if (frame == nullptr || width < kWindowPx || height < kWindowPx || box.x2 <= box.x1 || box.y2 <= box.y1) {
        return;
    }
    box_ = box;
    patch_left_ = centred((box.x1 + box.x2) / 2.0f, kPatchPx, width);
    patch_top_ = centred((box.y1 + box.y2) / 2.0f, kPatchPx, height);
    sample(frame, width, patch_left_, patch_top_, kPatch, template_);
    uint8_t low = 255;
    uint8_t high = 0;
    for (const uint8_t v : template_) {
        low = v < low ? v : low;
        high = v > high ? v : high;
    }
    // A flat patch matches everywhere, so it would only ever follow noise.
    active_ = high - low >= kMinContrast;
}

bool BoxTracker::update(const uint16_t *frame, int width, int height) noexcept
{
    if (!active_ || frame == nullptr || width < kWindowPx || height < kWindowPx) {
        return false;
    }
    const int window_left = clamp(patch_left_ - kRadius * kStep, 0, width - kWindowPx);
    const int window_top = clamp(patch_top_ - kRadius * kStep, 0, height - kWindowPx);
    sample(frame, width, window_left, window_top, kWindow, window_);

    const int stay_col = (patch_left_ - window_left) / kStep;
    const int stay_row = (patch_top_ - window_top) / kStep;
    const uint32_t stay = sad(stay_col, stay_row);
    uint32_t best = stay;
    int best_col = stay_col;
    int best_row = stay_row;
    for (int row = 0; row < kPositions; ++row) {
        for (int col = 0; col < kPositions; ++col) {
            const uint32_t cost = sad(col, row);
            if (cost < best) {
                best = cost;
                best_col = col;
                best_row = row;
            }
        }
    }
    if (best / (kPatch * kPatch) > kLostMeanDiff) {
        return false;
    }
    const int dx = window_left + best_col * kStep - patch_left_;
    const int dy = window_top + best_row * kStep - patch_top_;
    patch_left_ += dx;
    patch_top_ += dy;
    box_.x1 += static_cast<float>(dx);
    box_.x2 += static_cast<float>(dx);
    box_.y1 += static_cast<float>(dy);
    box_.y2 += static_cast<float>(dy);
    return true;
}

}  // namespace ui
