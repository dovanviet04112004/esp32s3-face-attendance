/** The anti-spoof branch on either runtime: the face crop in, one liveness score out.
 *  @ctx task | layer 3 of the pipeline in KEHOACH 3
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "ai_engine.h"
#include "core/tensor_view.hpp"

namespace ai {

/** Probability the face is live from the logits of the run that just finished,
 *  or a negative value when they are not the shape this branch expects.
 *  @ctx any | non-blocking
 */
float live_score(const TensorView &logits) noexcept;

/** Cut the face crop of one box, in frame pixels, into a buffer shaped and
 *  quantised like the input tensor: the largest square that fits the frame,
 *  slid to hold the face, at most the face side (KEHOACH 3).
 *  @ctx ai_task | blocking for the resample
 *  @param cap_bytes size of the buffer
 */
esp_err_t crop_face(const ai_engine_frame_t &frame, const float box[4], const TensorView &input,
                    int8_t *out, size_t cap_bytes) noexcept;

}  // namespace ai
