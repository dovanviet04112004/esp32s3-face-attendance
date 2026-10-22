/** The anti-spoof branch on either runtime: the face crop in, one liveness score out.
 *  @ctx task | runs on ai_task
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
 *  quantised like the input tensor: a square 2.7 times the face side, the
 *  largest that fits the frame when that is less, slid to hold the face (KEHOACH 3).
 *  @ctx ai_task | blocking for the resample
 *  @param cap_bytes size of the buffer
 */
esp_err_t crop_face(const ai_engine_frame_t &frame, const float box[4], const TensorView &input,
                    int8_t *out, size_t cap_bytes) noexcept;

}  // namespace ai
