/** The anti-spoof graph on TFLM: the face crop in, its logits out.
 *  @ctx task | invoke blocks | layer 3 of the pipeline in KEHOACH 3
 */
#pragma once

#include "antispoof/antispoof.hpp"
#include "core/tflm/tflite_model.hpp"

namespace ai {

/** The operators this graph carries, registered once and kept for good.
 *  @ctx task | non-blocking after the first call
 */
tflite::MicroOpResolver &spoof_ops() noexcept;

class SpoofModel final : public TfliteModelBase {
public:
    const char *name() const noexcept override { return "spoof"; }

    float score() noexcept { return live_score(view_of(output(0))); }

protected:
    tflite::MicroOpResolver &resolver() noexcept override { return spoof_ops(); }
};

}  // namespace ai
