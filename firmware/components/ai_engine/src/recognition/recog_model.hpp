/** The recognition branch: one aligned face in, an int8 embedding out.
 *  @ctx task | invoke blocks | layer 4 of the pipeline in KEHOACH 3
 */
#pragma once

#include <stddef.h>

#include "tflite_model.hpp"

namespace ai {

/** The operators this graph carries, registered once and kept for good.
 *  @ctx task | non-blocking after the first call
 */
tflite::MicroOpResolver &recog_ops() noexcept;

class RecogModel final : public TfliteModelBase {
public:
    const char *name() const noexcept override { return "recog"; }

    /** Copy the embedding out with the scale needed to read it as floats.
     *  @ret how many int8 values it copied, or zero when cap is too small
     */
    size_t embedding(int8_t *out, size_t cap_bytes, float *scale) noexcept;

protected:
    tflite::MicroOpResolver &resolver() noexcept override { return recog_ops(); }
};

}  // namespace ai
