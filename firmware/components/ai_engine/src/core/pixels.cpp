#include "pixels.hpp"

#include <math.h>

namespace ai {

namespace {

constexpr float kInt8Min = -128.0f;
constexpr float kInt8Max = 127.0f;

int clamp_index(int value, int limit) noexcept
{
    return value < 0 ? 0 : (value >= limit ? limit - 1 : value);
}

}  // namespace

Quantizer::Quantizer(const TfLiteTensor *tensor, float mean, float span) noexcept
    : mean_(mean), span_(span), inverse_scale_(1.0f / tensor->params.scale), zero_point_(tensor->params.zero_point)
{
}

int8_t Quantizer::operator()(float value) const noexcept
{
    const float q = rintf((value - mean_) / span_ * inverse_scale_) + static_cast<float>(zero_point_);
    return static_cast<int8_t>(q < kInt8Min ? kInt8Min : (q > kInt8Max ? kInt8Max : q));
}

void unpack_rgb565(uint16_t word, float rgb[kChannels]) noexcept
{
    const unsigned r = (word >> 11) & 0x1Fu;
    const unsigned g = (word >> 5) & 0x3Fu;
    const unsigned b = word & 0x1Fu;
    rgb[0] = static_cast<float>((r << 3) | (r >> 2));
    rgb[1] = static_cast<float>((g << 2) | (g >> 4));
    rgb[2] = static_cast<float>((b << 3) | (b >> 2));
}

void sample_bilinear(const ai_engine_frame_t &frame, float x, float y, float rgb[kChannels]) noexcept
{
    const float fx0 = floorf(x);
    const float fy0 = floorf(y);
    const float wx = x - fx0;
    const float wy = y - fy0;
    // Clamping keeps a face on the frame edge whole; dropped samples would leave holes (align.py).
    const int x0 = clamp_index(static_cast<int>(fx0), frame.width);
    const int x1 = clamp_index(static_cast<int>(fx0) + 1, frame.width);
    const int y0 = clamp_index(static_cast<int>(fy0), frame.height);
    const int y1 = clamp_index(static_cast<int>(fy0) + 1, frame.height);
    float p00[kChannels], p01[kChannels], p10[kChannels], p11[kChannels];
    unpack_rgb565(frame.pixels[y0 * frame.width + x0], p00);
    unpack_rgb565(frame.pixels[y0 * frame.width + x1], p01);
    unpack_rgb565(frame.pixels[y1 * frame.width + x0], p10);
    unpack_rgb565(frame.pixels[y1 * frame.width + x1], p11);
    for (int c = 0; c < kChannels; ++c) {
        const float top = p00[c] * (1.0f - wx) + p01[c] * wx;
        const float bottom = p10[c] * (1.0f - wx) + p11[c] * wx;
        rgb[c] = top * (1.0f - wy) + bottom * wy;
    }
}

void sample_area(const ai_engine_frame_t &frame, float x0, float y0, float x1, float y1,
                 float rgb[kChannels]) noexcept
{
    int left = clamp_index(static_cast<int>(floorf(x0)), frame.width);
    int top = clamp_index(static_cast<int>(floorf(y0)), frame.height);
    int right = clamp_index(static_cast<int>(ceilf(x1)) - 1, frame.width);
    int bottom = clamp_index(static_cast<int>(ceilf(y1)) - 1, frame.height);
    if (right < left) {
        right = left;
    }
    if (bottom < top) {
        bottom = top;
    }
    float sum[kChannels] = { 0.0f, 0.0f, 0.0f };
    for (int y = top; y <= bottom; ++y) {
        const uint16_t *row = frame.pixels + y * frame.width;
        for (int x = left; x <= right; ++x) {
            float px[kChannels];
            unpack_rgb565(row[x], px);
            for (int c = 0; c < kChannels; ++c) {
                sum[c] += px[c];
            }
        }
    }
    const float count = static_cast<float>((right - left + 1) * (bottom - top + 1));
    for (int c = 0; c < kChannels; ++c) {
        rgb[c] = sum[c] / count;
    }
}

void resample_square(const ai_engine_frame_t &frame, float left, float top, float side, TfLiteTensor *tensor,
                     const Quantizer &quant) noexcept
{
    const int size = tensor->dims->data[1];
    const float step = side / static_cast<float>(size);
    int8_t *out = tensor->data.int8;
    for (int row = 0; row < size; ++row) {
        const float y0 = top + row * step;
        for (int col = 0; col < size; ++col) {
            const float x0 = left + col * step;
            float rgb[kChannels];
            sample_area(frame, x0, y0, x0 + step, y0 + step, rgb);
            for (int c = 0; c < kChannels; ++c) {
                *out++ = quant(rgb[c]);
            }
        }
    }
}

}  // namespace ai
