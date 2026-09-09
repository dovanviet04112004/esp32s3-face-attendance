#include "detect_model.hpp"

namespace ai {

namespace {

// NMS_IOU in ml/tasks/detection/eval.py; both sides must keep the same face count.
constexpr float kIou = 0.3f;

float overlap(const float *a, const float *b)
{
    const float left = a[0] > b[0] ? a[0] : b[0];
    const float top = a[1] > b[1] ? a[1] : b[1];
    const float right = a[2] < b[2] ? a[2] : b[2];
    const float bottom = a[3] < b[3] ? a[3] : b[3];
    const float width = right > left ? right - left : 0.0f;
    const float height = bottom > top ? bottom - top : 0.0f;
    const float inter = width * height;
    const float joined = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    return joined > 0.0f ? inter / joined : 0.0f;
}

}  // namespace

size_t suppress(ai_engine_face_t *faces, size_t count) noexcept
{
    size_t kept = 0;
    for (size_t i = 0; i < count; ++i) {
        bool covered = false;
        for (size_t k = 0; k < kept && !covered; ++k) {
            covered = overlap(faces[k].box, faces[i].box) > kIou;
        }
        if (covered) {
            continue;
        }
        if (kept != i) {
            faces[kept] = faces[i];
        }
        ++kept;
    }
    return kept;
}

}  // namespace ai
