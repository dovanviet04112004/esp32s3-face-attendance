#include "recog_model.hpp"

#include <math.h>

namespace ai {

namespace {

constexpr int kEmbedDim = 512;
constexpr float kNormEps = 1e-10f;
constexpr float kInt8Peak = 127.0f;

}  // namespace

size_t normalized_int8(const TensorView &tensor, int8_t *out, size_t cap_bytes, float *scale) noexcept
{
    if (!tensor.valid() || out == nullptr || scale == nullptr || tensor.bytes != kEmbedDim ||
        cap_bytes < kEmbedDim) {
        return 0;
    }
    float unit[kEmbedDim];
    float sum_sq = 0.0f;
    for (int i = 0; i < kEmbedDim; ++i) {
        unit[i] = (static_cast<float>(tensor.data[i]) - static_cast<float>(tensor.zero_point)) * tensor.scale;
        sum_sq += unit[i] * unit[i];
    }
    // The floor keeps a dead frame at zero rather than a unit vector pointing anywhere (l2norm.py).
    const float norm = sqrtf(sum_sq);
    const float inverse = 1.0f / (norm > kNormEps ? norm : kNormEps);
    float peak = 0.0f;
    for (int i = 0; i < kEmbedDim; ++i) {
        unit[i] *= inverse;
        const float magnitude = fabsf(unit[i]);
        peak = magnitude > peak ? magnitude : peak;
    }
    *scale = peak > 0.0f ? peak / kInt8Peak : 0.0f;
    for (int i = 0; i < kEmbedDim; ++i) {
        const float q = *scale > 0.0f ? rintf(unit[i] / *scale) : 0.0f;
        out[i] = static_cast<int8_t>(q < -kInt8Peak ? -kInt8Peak : (q > kInt8Peak ? kInt8Peak : q));
    }
    return kEmbedDim;
}

}  // namespace ai
