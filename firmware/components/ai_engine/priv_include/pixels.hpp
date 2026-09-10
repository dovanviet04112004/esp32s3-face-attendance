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
constexpr int kByteLevels = 256;

/** One channel's 0..255 value to the tensor's int8 after (v - mean) / span. */
class Quantizer {
public:
    Quantizer(const TfLiteTensor *tensor, float mean, float span) noexcept;
    int8_t operator()(float value) const noexcept;
    int8_t byte(unsigned value) const noexcept { return table_[value]; }

private:
    float mean_;
    float span_;
    float inverse_scale_;
    int zero_point_;
    int8_t table_[kByteLevels];
};

/** The three 8-bit channels of one RGB565 word, high bits replicated into the low ones. */
void unpack_rgb565(uint16_t word, unsigned rgb[kChannels]) noexcept;

/** Bilinear sample at a fractional position, clamped to the frame border. */
void sample_bilinear(const ai_engine_frame_t &frame, float x, float y, float rgb[kChannels]) noexcept;

/** Resample one frame rectangle onto a size x size x 3 int8 block by area averaging. */
void resample_square(const ai_engine_frame_t &frame, float left, float top, float side, int size, int8_t *out,
                     const Quantizer &quant) noexcept;

/** Resample the whole frame to new_w x new_h by area averaging, writing NHWC int8
 *  rows of out_w pixels starting at out; out must hold new_h rows of out_w pixels. */
void resample_frame(const ai_engine_frame_t &frame, int new_w, int new_h, int8_t *out, int out_w,
                    const Quantizer &quant) noexcept;

}  // namespace ai
