#include "pixels.hpp"

#include <math.h>

namespace ai {

namespace {

constexpr float kInt8Min = -128.0f;
constexpr float kInt8Max = 127.0f;
constexpr int kMaxSide = 320;

int clamp_index(int value, int limit) noexcept
{
    return value < 0 ? 0 : (value >= limit ? limit - 1 : value);
}

// Source pixel range [first, last] covering destination cell i of `count` cells over [origin, origin + span).
void cell_bounds(float origin, float span, int count, int limit, int *first, int *last) noexcept
{
    const float step = span / static_cast<float>(count);
    for (int i = 0; i < count; ++i) {
        const float lo = origin + i * step;
        const float hi = lo + step;
        int a = clamp_index(static_cast<int>(floorf(lo)), limit);
        int b = clamp_index(static_cast<int>(ceilf(hi)) - 1, limit);
        if (b < a) {
            b = a;
        }
        first[i] = a;
        last[i] = b;
    }
}

void area_rows(const ai_engine_frame_t &frame, const int *col_first, const int *col_last, int cols, int row_first,
               int row_last, int8_t *out, const Quantizer &quant, int planes) noexcept
{
    for (int c = 0; c < cols; ++c) {
        unsigned sum[kChannels] = { 0, 0, 0 };
        for (int y = row_first; y <= row_last; ++y) {
            const size_t row = static_cast<size_t>(y) * frame.width;
            for (int x = col_first[c]; x <= col_last[c]; ++x) {
                unsigned px[kChannels];
                unpack_rgb565(frame_word(frame, row + x), px);
                sum[0] += px[0];
                sum[1] += px[1];
                sum[2] += px[2];
            }
        }
        const unsigned count = static_cast<unsigned>((col_last[c] - col_first[c] + 1) * (row_last - row_first + 1));
        unsigned mean[kChannels];
        for (int k = 0; k < kChannels; ++k) {
            mean[k] = (sum[k] + count / 2) / count;
            *out++ = quant.byte(mean[k]);
        }
        if (planes > kChannels) {
            unsigned high = mean[0] > mean[1] ? mean[0] : mean[1];
            high = high > mean[2] ? high : mean[2];
            unsigned low = mean[0] < mean[1] ? mean[0] : mean[1];
            low = low < mean[2] ? low : mean[2];
            // The plane carries the same 0..1 range as the three beside it, so
            // it goes through the same table rather than a scale of its own.
            *out++ = quant.byte(high > 0 ? ((high - low) * (kByteLevels - 1) + high / 2) / high : 0);
        }
    }
}

}  // namespace

Quantizer::Quantizer(const TfLiteTensor *tensor, float mean, float span) noexcept
    : mean_(mean), span_(span), inverse_scale_(1.0f / tensor->params.scale), zero_point_(tensor->params.zero_point)
{
    for (int v = 0; v < kByteLevels; ++v) {
        table_[v] = (*this)(static_cast<float>(v));
    }
}

int8_t Quantizer::operator()(float value) const noexcept
{
    const float q = rintf((value - mean_) / span_ * inverse_scale_) + static_cast<float>(zero_point_);
    return static_cast<int8_t>(q < kInt8Min ? kInt8Min : (q > kInt8Max ? kInt8Max : q));
}

void unpack_rgb565(uint16_t word, unsigned rgb[kChannels]) noexcept
{
    const unsigned r = (word >> 11) & 0x1Fu;
    const unsigned g = (word >> 5) & 0x3Fu;
    const unsigned b = word & 0x1Fu;
    rgb[0] = (r << 3) | (r >> 2);
    rgb[1] = (g << 2) | (g >> 4);
    rgb[2] = (b << 3) | (b >> 2);
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
    unsigned p00[kChannels], p01[kChannels], p10[kChannels], p11[kChannels];
    unpack_rgb565(frame_word(frame, static_cast<size_t>(y0) * frame.width + x0), p00);
    unpack_rgb565(frame_word(frame, static_cast<size_t>(y0) * frame.width + x1), p01);
    unpack_rgb565(frame_word(frame, static_cast<size_t>(y1) * frame.width + x0), p10);
    unpack_rgb565(frame_word(frame, static_cast<size_t>(y1) * frame.width + x1), p11);
    for (int c = 0; c < kChannels; ++c) {
        const float top = p00[c] * (1.0f - wx) + p01[c] * wx;
        const float bottom = p10[c] * (1.0f - wx) + p11[c] * wx;
        rgb[c] = top * (1.0f - wy) + bottom * wy;
    }
}

void resample_square(const ai_engine_frame_t &frame, float left, float top, float side, int size, int8_t *out,
                     const Quantizer &quant, int planes) noexcept
{
    if (size > kMaxSide) {
        return;
    }
    int col_first[kMaxSide], col_last[kMaxSide], row_first[kMaxSide], row_last[kMaxSide];
    cell_bounds(left, side, size, frame.width, col_first, col_last);
    cell_bounds(top, side, size, frame.height, row_first, row_last);
    for (int row = 0; row < size; ++row) {
        area_rows(frame, col_first, col_last, size, row_first[row], row_last[row],
                  out + (size_t)row * size * planes, quant, planes);
    }
}

void resample_frame(const ai_engine_frame_t &frame, int new_w, int new_h, int8_t *out, int out_w,
                    const Quantizer &quant) noexcept
{
    if (new_w > kMaxSide || new_h > kMaxSide) {
        return;
    }
    int col_first[kMaxSide], col_last[kMaxSide], row_first[kMaxSide], row_last[kMaxSide];
    cell_bounds(0.0f, static_cast<float>(frame.width), new_w, frame.width, col_first, col_last);
    cell_bounds(0.0f, static_cast<float>(frame.height), new_h, frame.height, row_first, row_last);
    for (int row = 0; row < new_h; ++row) {
        area_rows(frame, col_first, col_last, new_w, row_first[row], row_last[row], out + row * out_w * kChannels,
                  quant, kChannels);
    }
}

}  // namespace ai
