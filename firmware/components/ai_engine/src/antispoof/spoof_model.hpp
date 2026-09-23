/** The anti-spoof branch: the face crop in, one liveness score out.
 *  @ctx task | invoke blocks | layer 3 of the pipeline in KEHOACH 3
 */
#pragma once

#include "ai_engine.h"
#include "tensor_view.hpp"
#include "tflite_model.hpp"

namespace ai {

/** The operators this graph carries, registered once and kept for good.
 *  @ctx task | non-blocking after the first call
 */
tflite::MicroOpResolver &spoof_ops() noexcept;

/** Probability the face is live from the logits of the run that just finished,
 *  or a negative value when they are not the shape this branch expects.
 *  @ctx any | non-blocking
 */
float live_score(const TensorView &logits) noexcept;

class SpoofModel final : public TfliteModelBase {
public:
    const char *name() const noexcept override { return "spoof"; }

    float score() noexcept { return live_score(view_of(output(0))); }

protected:
    tflite::MicroOpResolver &resolver() noexcept override { return spoof_ops(); }
};

/** Cut the face crop of one box, in frame pixels, into a buffer shaped and
 *  quantised like the input tensor: the largest square that fits the frame,
 *  slid to hold the face, at most the face side (KEHOACH 3).
 *  @ctx ai_task | blocking for the resample
 *  @param cap_bytes size of the buffer
 */
esp_err_t crop_face(const ai_engine_frame_t &frame, const float box[4], const TensorView &input,
                    int8_t *out, size_t cap_bytes) noexcept;

}  // namespace ai
