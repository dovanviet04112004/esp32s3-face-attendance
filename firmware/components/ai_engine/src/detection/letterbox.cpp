#include "detect_model.hpp"

#include <math.h>
#include <string.h>

#include "pixels.hpp"

namespace ai {

namespace {

constexpr float kPixelMean = 0.0f;
constexpr float kPixelSpan = 255.0f;

}  // namespace

esp_err_t letterbox_frame(const ai_engine_frame_t &frame, const TensorView &input,
                          ai_engine_letterbox_t *geometry) noexcept
{
    if (frame.pixels == nullptr || frame.width <= 0 || frame.height <= 0 || !input.valid() || geometry == nullptr ||
        input.rank != 4 || input.dims[3] != kChannels) {
        return ESP_ERR_INVALID_ARG;
    }
    const int out_h = input.dims[1];
    const int out_w = input.dims[2];
    // Same arithmetic as letterbox_params in ml/tasks/detection/data.py; the boxes come back through it.
    const float scale = fminf(static_cast<float>(out_h) / frame.height, static_cast<float>(out_w) / frame.width);
    const int new_h = static_cast<int>(rintf(frame.height * scale));
    const int new_w = static_cast<int>(rintf(frame.width * scale));
    geometry->scale = scale;
    geometry->pad_x = (out_w - new_w) / 2;
    geometry->pad_y = (out_h - new_h) / 2;

    const Quantizer quant(input, kPixelMean, kPixelSpan);
    memset(input.data, quant.byte(0), input.bytes);
    int8_t *origin = input.data + (geometry->pad_y * out_w + geometry->pad_x) * kChannels;
    resample_frame(frame, new_w, new_h, origin, out_w, quant);
    return ESP_OK;
}

}  // namespace ai

extern "C" void ai_engine_face_to_frame(const ai_engine_letterbox_t *geometry, ai_engine_face_t *face)
{
    if (geometry == nullptr || face == nullptr || geometry->scale <= 0.0f) {
        return;
    }
    for (int i = 0; i < 4; ++i) {
        const float pad = (i % 2 == 0) ? static_cast<float>(geometry->pad_x) : static_cast<float>(geometry->pad_y);
        face->box[i] = (face->box[i] - pad) / geometry->scale;
    }
    for (int i = 0; i < 10; ++i) {
        const float pad = (i % 2 == 0) ? static_cast<float>(geometry->pad_x) : static_cast<float>(geometry->pad_y);
        face->landmarks[i] = (face->landmarks[i] - pad) / geometry->scale;
    }
}
