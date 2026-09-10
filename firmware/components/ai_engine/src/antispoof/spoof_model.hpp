/** The anti-spoof branch: two crops of one face in, one liveness score out.
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

/** Cut the tight and wide crops of one face box, in frame pixels, into two
 *  buffers shaped and quantised like the input tensors; the wide square is the
 *  largest that fits, at most 2.7x (KEHOACH 3).
 *  @ctx ai_task | blocking for the two resamples
 *  @param cap_bytes size of each buffer; @param wide_scale the context ratio the frame allowed
 */
esp_err_t crop_pair(const ai_engine_frame_t &frame, const float box[4], const TfLiteTensor *tight,
                    const TfLiteTensor *wide, int8_t *tight_out, int8_t *wide_out, size_t cap_bytes,
                    float *wide_scale) noexcept;

}  // namespace ai
