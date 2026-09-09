/** The recognition branch: one aligned face in, an int8 embedding out.
 *  @ctx task | invoke blocks | layer 4 of the pipeline in KEHOACH 3
 */
#pragma once

#include <stddef.h>

#include "ai_engine.h"
#include "tflite_model.hpp"

namespace ai {

/** The operators this graph carries, registered once and kept for good.
 *  @ctx task | non-blocking after the first call
 */
tflite::MicroOpResolver &recog_ops() noexcept;

class RecogModel final : public TfliteModelBase {
public:
    const char *name() const noexcept override { return "recog"; }

    /** Copy the embedding out, unit length, as symmetric int8 with its own scale.
     *  @ret how many int8 values it copied, or zero when cap is too small
     */
    size_t embedding(int8_t *out, size_t cap_bytes, float *scale) noexcept;

protected:
    tflite::MicroOpResolver &resolver() noexcept override { return recog_ops(); }
};

/** Warp one face onto the input tensor by its five landmarks in frame pixels (align.py).
 *  @ctx ai_task | blocking for the warp
 *  @ret ESP_OK | ESP_ERR_INVALID_ARG when the landmarks collapse to a point
 */
esp_err_t align_face(const ai_engine_frame_t &frame, const float landmarks[10], TfLiteTensor *input) noexcept;

/** Dequantise an embedding tensor, divide out its length and requantise it
 *  per vector (l2norm.py, then cosine.py quantize), so a record stores int8 + scale.
 *  @ctx any | non-blocking
 */
size_t normalized_int8(const TfLiteTensor *tensor, int8_t *out, size_t cap_bytes, float *scale) noexcept;

}  // namespace ai
