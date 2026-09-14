/** The anti-spoof branch: the face crop in, one liveness score out.
 *  @ctx task | invoke blocks | layer 3 of the pipeline in KEHOACH 3
 */
#pragma once

#include "ai_engine.h"
#include "tflite_model.hpp"

namespace ai {

/** The operators this graph carries, registered once and kept for good.
 *  @ctx task | non-blocking after the first call
 */
tflite::MicroOpResolver &spoof_ops() noexcept;

class SpoofModel final : public TfliteModelBase {
public:
    const char *name() const noexcept override { return "spoof"; }

    /** Probability the face is live, or a negative value when no run has
     *  produced an output of the shape this branch expects.
     */
    float score() noexcept;

protected:
    tflite::MicroOpResolver &resolver() noexcept override { return spoof_ops(); }
};

/** Cut the face crop of one box, in frame pixels, into a buffer shaped and
 *  quantised like the input tensor: the largest square that fits the frame,
 *  slid to hold the face, at most the face side (KEHOACH 3).
 *  @ctx ai_task | blocking for the resample
 *  @param cap_bytes size of the buffer
 */
esp_err_t crop_face(const ai_engine_frame_t &frame, const float box[4], const TfLiteTensor *input,
                    int8_t *out, size_t cap_bytes) noexcept;

/** Mean absolute Laplacian of the crop's contrast-normalised luma, a number that
 *  reads surface texture rather than exposure (KEHOACH 3). Negative when the
 *  crop is too small or has fewer planes than the branch expects.
 *  @ctx ai_task | blocking for two passes over the crop
 *  @param side pixels along one edge, planes interleaved channels per pixel
 */
float surface_sharpness(const int8_t *crop, int side, int planes) noexcept;

}  // namespace ai
