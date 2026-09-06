#include "spoof_model.hpp"

#include <math.h>

namespace ai {

namespace {

// Class order comes from facepipe.tasks.antispoof.losses.task_loss.
constexpr int kLive = 0;
constexpr int kClasses = 2;

}

float SpoofModel::score() noexcept
{
    const TfLiteTensor *logits = output(0);
    if (logits == nullptr || logits->type != kTfLiteInt8 ||
        logits->dims->data[logits->dims->size - 1] != kClasses) {
        return -1.0F;
    }
    float value[kClasses];
    for (int i = 0; i < kClasses; ++i) {
        value[i] = logits->params.scale *
                   static_cast<float>(logits->data.int8[i] - logits->params.zero_point);
    }
    const float top = value[0] > value[1] ? value[0] : value[1];
    const float live = expf(value[kLive] - top);
    return live / (expf(value[0] - top) + expf(value[1] - top));
}

}  // namespace ai
