/** The anti-spoof branch: two crops of one face in, one liveness score out.
 *  @ctx task | invoke blocks | layer 3 of the pipeline in KEHOACH 3
 */
#pragma once

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

}  // namespace ai
