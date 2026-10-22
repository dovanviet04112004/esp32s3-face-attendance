/** The recognition branch on either runtime: one face aligned in, a unit int8 embedding out.
 *  @ctx task | runs on ai_task
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "ai_engine.h"
#include "core/tensor_view.hpp"

namespace ai {

/** Warp one face by its five landmarks in frame pixels into a buffer shaped
 *  and quantised like the input tensor (align.py); out may be the tensor's own data.
 *  @ctx ai_task | blocking for the warp
 *  @ret ESP_OK | ESP_ERR_INVALID_ARG when the landmarks collapse to a point | ESP_ERR_INVALID_SIZE
 */
esp_err_t align_face(const ai_engine_frame_t &frame, const float landmarks[10], const TensorView &input,
                     int8_t *out, size_t cap_bytes) noexcept;

/** Dequantise an embedding tensor, divide out its length and requantise it
 *  per vector (l2norm.py, then cosine.py quantize), so a record stores int8 + scale.
 *  @ctx any | non-blocking
 */
size_t normalized_int8(const TensorView &tensor, int8_t *out, size_t cap_bytes, float *scale) noexcept;

}  // namespace ai
