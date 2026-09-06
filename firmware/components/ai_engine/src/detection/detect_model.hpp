/** The detection branch: one letterboxed frame in, raw head tensors out.
 *  @ctx task | invoke blocks | layer 2 of the pipeline in KEHOACH 3
 */
#pragma once

#include "tflite_model.hpp"

namespace ai {

/** The operators this graph carries, registered once and kept for good.
 *  @ctx task | non-blocking after the first call
 */
tflite::MicroOpResolver &detect_ops() noexcept;

class DetectModel final : public TfliteModelBase {
public:
    const char *name() const noexcept override { return "detect"; }

protected:
    tflite::MicroOpResolver &resolver() noexcept override { return detect_ops(); }
};

}  // namespace ai
