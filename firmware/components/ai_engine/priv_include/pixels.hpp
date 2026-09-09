/** Pixels shared by every branch: unpacking the camera's RGB565, sampling a
 *  frame, and writing 0..255 values into an int8 tensor under its quantisation.
 *  @ctx any | non-blocking | knows no model by name (KEHOACH 4.5.6)
 */
#pragma once

#include <stdint.h>

#include "ai_engine.h"
#include "tensorflow/lite/core/c/common.h"

namespace ai {

constexpr int kChannels = 3;

/** One channel's 0..255 value to the tensor's int8 after (v - mean) / span. */
class Quantizer {
public:
    Quantizer(const TfLiteTensor *tensor, float mean, float span) noexcept;
    int8_t operator()(float value) const noexcept;

private:
    float mean_;
    float span_;
    float inverse_scale_;
    int zero_point_;
};

/** The three 8-bit channels of one RGB565 word, high bits replicated into the low ones. */
void unpack_rgb565(uint16_t word, float rgb[kChannels]) noexcept;

/** Bilinear sample at a fractional position, clamped to the frame border. */
void sample_bilinear(const ai_engine_frame_t &frame, float x, float y, float rgb[kChannels]) noexcept;

/** Mean of every source pixel whose centre falls inside [x0, x1) x [y0, y1), clamped to the frame. */
void sample_area(const ai_engine_frame_t &frame, float x0, float y0, float x1, float y1,
                 float rgb[kChannels]) noexcept;

/** Resample one frame rectangle onto a square int8 NHWC tensor region by area averaging. */
void resample_square(const ai_engine_frame_t &frame, float left, float top, float side, TfLiteTensor *tensor,
                     const Quantizer &quant) noexcept;

}  // namespace ai
