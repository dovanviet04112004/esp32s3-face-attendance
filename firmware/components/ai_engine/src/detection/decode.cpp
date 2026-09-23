#include "detect_model.hpp"

#include <math.h>

namespace ai {

namespace {

constexpr int kStrides[] = { 8, 16, 32 };
constexpr int kLevels = 3;
constexpr int kClassChannels = 1;
constexpr int kBoxChannels = 4;
constexpr int kLandmarkChannels = 10;
constexpr int kLandmarks = 5;
// The cap sits ahead of the quadratic NMS on purpose: a device budget the scene cannot grow (KEHOACH 4.5.6).
constexpr size_t kCandidates = 32;
constexpr float kScoreEps = 1e-6f;

struct Level {
    const TensorView *cls = nullptr;
    const TensorView *box = nullptr;
    const TensorView *kps = nullptr;
    int stride = 0;
    int rows = 0;
    int cols = 0;
};

ai_engine_face_t s_found[kCandidates];

int level_of(const TensorView &tensor, int in_h, int in_w)
{
    for (int i = 0; i < kLevels; ++i) {
        if (tensor.dims[1] == in_h / kStrides[i] && tensor.dims[2] == in_w / kStrides[i]) {
            return i;
        }
    }
    return -1;
}

// The graph lists nine heads in an order the exporter chose; channel count and
// feature size identify each one without trusting that order.
bool gather(const TensorView &input, const TensorView *heads, size_t count, Level levels[kLevels])
{
    if (!input.valid() || input.rank != 4 || heads == nullptr) {
        return false;
    }
    const int in_h = input.dims[1];
    const int in_w = input.dims[2];
    for (size_t i = 0; i < count; ++i) {
        const TensorView &tensor = heads[i];
        if (!tensor.valid() || tensor.rank != 4) {
            return false;
        }
        const int level = level_of(tensor, in_h, in_w);
        if (level < 0) {
            return false;
        }
        Level &at = levels[level];
        at.stride = kStrides[level];
        at.rows = tensor.dims[1];
        at.cols = tensor.dims[2];
        switch (tensor.dims[3]) {
        case kClassChannels:
            at.cls = &tensor;
            break;
        case kBoxChannels:
            at.box = &tensor;
            break;
        case kLandmarkChannels:
            at.kps = &tensor;
            break;
        default:
            return false;
        }
    }
    for (int i = 0; i < kLevels; ++i) {
        if (levels[i].cls == nullptr || levels[i].box == nullptr || levels[i].kps == nullptr) {
            return false;
        }
    }
    return true;
}

float dequant(const TensorView *tensor, int index)
{
    return (static_cast<float>(tensor->data[index]) - static_cast<float>(tensor->zero_point)) * tensor->scale;
}

// Sorted best first; an equal score lands after the earlier prior, the tie order the reference keeps.
size_t admit(ai_engine_face_t *found, size_t count, const ai_engine_face_t &face)
{
    size_t at = count;
    while (at > 0 && found[at - 1].score < face.score) {
        --at;
    }
    if (at >= kCandidates) {
        return count;
    }
    const size_t last = count < kCandidates ? count : kCandidates - 1;
    for (size_t i = last; i > at; --i) {
        found[i] = found[i - 1];
    }
    found[at] = face;
    return count < kCandidates ? count + 1 : kCandidates;
}

void decode_cell(const Level &level, int row, int col, float score, ai_engine_face_t &face)
{
    const int cell = row * level.cols + col;
    const float stride = static_cast<float>(level.stride);
    const float prior_x = static_cast<float>(col * level.stride);
    const float prior_y = static_cast<float>(row * level.stride);
    const float centre_x = dequant(level.box, cell * kBoxChannels) * stride + prior_x;
    const float centre_y = dequant(level.box, cell * kBoxChannels + 1) * stride + prior_y;
    const float width = expf(dequant(level.box, cell * kBoxChannels + 2)) * stride;
    const float height = expf(dequant(level.box, cell * kBoxChannels + 3)) * stride;
    face.box[0] = centre_x - width / 2;
    face.box[1] = centre_y - height / 2;
    face.box[2] = centre_x + width / 2;
    face.box[3] = centre_y + height / 2;
    for (int k = 0; k < kLandmarks; ++k) {
        face.landmarks[2 * k] = dequant(level.kps, cell * kLandmarkChannels + 2 * k) * stride + prior_x;
        face.landmarks[2 * k + 1] = dequant(level.kps, cell * kLandmarkChannels + 2 * k + 1) * stride + prior_y;
    }
    face.score = score;
}

}  // namespace

size_t decode_faces(const TensorView &input, const TensorView *heads, size_t count, float min_score,
                    ai_engine_face_t *out, size_t cap) noexcept
{
    Level levels[kLevels];
    if (out == nullptr || cap == 0 || !gather(input, heads, count, levels)) {
        return 0;
    }
    // Sigmoid is monotonic, so the floor moves onto the logit and exp runs only for survivors.
    const float floor = min_score < kScoreEps ? kScoreEps : (min_score > 1.0f - kScoreEps ? 1.0f - kScoreEps : min_score);
    const float floor_logit = logf(floor / (1.0f - floor));
    size_t found = 0;
    for (int i = 0; i < kLevels; ++i) {
        const Level &level = levels[i];
        for (int row = 0; row < level.rows; ++row) {
            for (int col = 0; col < level.cols; ++col) {
                const float logit = dequant(level.cls, row * level.cols + col);
                if (logit < floor_logit) {
                    continue;
                }
                ai_engine_face_t face;
                decode_cell(level, row, col, 1.0f / (1.0f + expf(-logit)), face);
                found = admit(s_found, found, face);
            }
        }
    }
    found = suppress(s_found, found);
    if (found > cap) {
        found = cap;
    }
    for (size_t i = 0; i < found; ++i) {
        out[i] = s_found[i];
    }
    return found;
}

}  // namespace ai
