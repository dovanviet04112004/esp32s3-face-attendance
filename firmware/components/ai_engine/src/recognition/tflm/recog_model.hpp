/** The recognition graph on TFLM: one aligned face in, its embedding tensor out.
 *  @ctx task | invoke blocks | layer 4 of the pipeline in KEHOACH 3
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "core/tflm/tflite_model.hpp"
#include "recognition/recognition.hpp"

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
    size_t embedding(int8_t *out, size_t cap_bytes, float *scale) noexcept
    {
        return normalized_int8(view_of(output(0)), out, cap_bytes, scale);
    }

protected:
    tflite::MicroOpResolver &resolver() noexcept override { return recog_ops(); }
};

}  // namespace ai
