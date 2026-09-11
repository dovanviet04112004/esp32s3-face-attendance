#include "spoof_model.hpp"

#include <math.h>

#include "pixels.hpp"

namespace ai {

namespace {

// CROP_SCALES in ml/data/prepare/celeba_spoof_parquet.py: the face crop is 1.0 of the box.
constexpr float kFaceScale = 1.0f;
constexpr float kPixelMean = 0.0f;
constexpr float kPixelSpan = 255.0f;

struct Square {
    float left;
    float top;
    float side;
    float reached;
};

// The largest square that fits the frame, capped at scale, slid to hold the face:
// no stretch and no invented context (KEHOACH 3, fitted_box).
Square fitted(const float box[4], float scale, int width, int height)
{
    const float cx = (box[0] + box[2]) / 2.0f;
    const float cy = (box[1] + box[3]) / 2.0f;
    const float face = fmaxf(1.0f, fmaxf(box[2] - box[0], box[3] - box[1]));
    const float limit = fminf(face * scale, fminf(static_cast<float>(width), static_cast<float>(height)));
    const float side = fmaxf(1.0f, floorf(limit));
    Square out;
    out.side = side;
    out.left = fminf(fmaxf(0.0f, rintf(cx - side / 2.0f)), static_cast<float>(width) - side);
    out.top = fminf(fmaxf(0.0f, rintf(cy - side / 2.0f)), static_cast<float>(height) - side);
    out.reached = side / face;
    return out;
}

}  // namespace

esp_err_t crop_face(const ai_engine_frame_t &frame, const float box[4], const TfLiteTensor *input,
                    int8_t *out, size_t cap_bytes) noexcept
{
    if (frame.pixels == nullptr || box == nullptr || input == nullptr || out == nullptr ||
        input->dims->size != 4 || input->dims->data[3] != kChannels) {
        return ESP_ERR_INVALID_ARG;
    }
    if (cap_bytes < input->bytes) {
        return ESP_ERR_INVALID_SIZE;
    }
    if (box[2] <= box[0] || box[3] <= box[1]) {
        return ESP_ERR_INVALID_ARG;
    }
    const Square face = fitted(box, kFaceScale, frame.width, frame.height);
    resample_square(frame, face.left, face.top, face.side, input->dims->data[1], out,
                    Quantizer(input, kPixelMean, kPixelSpan));
    return ESP_OK;
}

}  // namespace ai
