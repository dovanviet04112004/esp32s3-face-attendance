#include "recog_model.hpp"

#include <math.h>

#include "pixels.hpp"

namespace ai {

namespace {

constexpr int kLandmarks = 5;
// ArcFace's reference points on a 112 grid, the geometry of the MS1MV3 crops (align.py).
constexpr float kReferenceBasis = 112.0f;
constexpr float kReference[kLandmarks][2] = {
    { 38.2946f, 51.6963f }, { 73.5318f, 51.5014f }, { 56.0252f, 71.7366f }, { 41.5493f, 92.3655f }, { 70.7299f, 92.2041f },
};
constexpr float kPixelMean = 127.5f;
constexpr float kPixelSpan = 127.5f;
constexpr float kByteMax = 255.0f;

struct Similarity {
    float a;
    float b;
    float tx;
    float ty;
};

// Least-squares rotation, uniform scale and shift; the closed form of a proper
// similarity has no reflection to guard against, which is what align.py's guard enforces.
bool fit(const float landmarks[2 * kLandmarks], float size, Similarity &out)
{
    float sx = 0, sy = 0, tx = 0, ty = 0;
    for (int i = 0; i < kLandmarks; ++i) {
        sx += landmarks[2 * i];
        sy += landmarks[2 * i + 1];
        tx += kReference[i][0];
        ty += kReference[i][1];
    }
    const float ref_scale = size / kReferenceBasis;
    sx /= kLandmarks;
    sy /= kLandmarks;
    tx = tx / kLandmarks * ref_scale;
    ty = ty / kLandmarks * ref_scale;
    float dot = 0, cross = 0, norm = 0;
    for (int i = 0; i < kLandmarks; ++i) {
        const float x = landmarks[2 * i] - sx;
        const float y = landmarks[2 * i + 1] - sy;
        const float u = kReference[i][0] * ref_scale - tx;
        const float v = kReference[i][1] * ref_scale - ty;
        dot += x * u + y * v;
        cross += x * v - y * u;
        norm += x * x + y * y;
    }
    if (norm <= 0.0f) {
        return false;
    }
    out.a = dot / norm;
    out.b = cross / norm;
    out.tx = tx - (out.a * sx - out.b * sy);
    out.ty = ty - (out.b * sx + out.a * sy);
    return true;
}

}  // namespace

esp_err_t align_face(const ai_engine_frame_t &frame, const float landmarks[10], const TensorView &input,
                     int8_t *out, size_t cap_bytes) noexcept
{
    if (frame.pixels == nullptr || landmarks == nullptr || !input.valid() || out == nullptr ||
        input.rank != 4 || input.dims[3] != kChannels) {
        return ESP_ERR_INVALID_ARG;
    }
    if (cap_bytes < input.bytes) {
        return ESP_ERR_INVALID_SIZE;
    }
    const int size = input.dims[1];
    Similarity m;
    if (!fit(landmarks, static_cast<float>(size), m)) {
        return ESP_ERR_INVALID_ARG;
    }
    // The warp walks the destination and samples the source through the inverse map (align.py).
    const float det = m.a * m.a + m.b * m.b;
    if (det <= 0.0f) {
        return ESP_ERR_INVALID_ARG;
    }
    const float ia = m.a / det;
    const float ib = -m.b / det;
    const Quantizer quant(input, kPixelMean, kPixelSpan);
    for (int row = 0; row < size; ++row) {
        for (int col = 0; col < size; ++col) {
            const float dx = static_cast<float>(col) - m.tx;
            const float dy = static_cast<float>(row) - m.ty;
            const float x = ia * dx - ib * dy;
            const float y = ib * dx + ia * dy;
            float rgb[kChannels];
            sample_bilinear(frame, x, y, rgb);
            for (int c = 0; c < kChannels; ++c) {
                const float byte = floorf(rgb[c] < 0.0f ? 0.0f : (rgb[c] > kByteMax ? kByteMax : rgb[c]));
                *out++ = quant(byte);
            }
        }
    }
    return ESP_OK;
}

}  // namespace ai
