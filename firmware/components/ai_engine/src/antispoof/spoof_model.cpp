#include "spoof_model.hpp"

#include <math.h>

namespace ai {

namespace {

// Class order comes from facepipe.tasks.antispoof.losses.task_loss: live is first.
constexpr int kLive = 0;
constexpr int kMaxClasses = 4;

}

float live_score(const TensorView &logits) noexcept
{
    if (!logits.valid() || logits.rank < 1) {
        return -1.0F;
    }
    const int classes = logits.dims[logits.rank - 1];
    if (classes < 2 || classes > kMaxClasses) {
        return -1.0F;
    }
    float value[kMaxClasses];
    float top = -1e30F;
    for (int i = 0; i < classes; ++i) {
        value[i] = logits.scale * static_cast<float>(logits.data[i] - logits.zero_point);
        top = value[i] > top ? value[i] : top;
    }
    float total = 0.0F;
    for (int i = 0; i < classes; ++i) {
        total += expf(value[i] - top);
    }
    return expf(value[kLive] - top) / total;
}

}  // namespace ai
