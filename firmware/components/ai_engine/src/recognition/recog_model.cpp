#include "recog_model.hpp"

#include <string.h>

namespace ai {

size_t RecogModel::embedding(int8_t *out, size_t cap, float *scale) noexcept
{
    const TfLiteTensor *tensor = output(0);
    if (tensor == nullptr || out == nullptr || scale == nullptr) {
        return 0;
    }
    if (tensor->type != kTfLiteInt8 || tensor->bytes > cap) {
        return 0;
    }
    memcpy(out, tensor->data.int8, tensor->bytes);
    *scale = tensor->params.scale;
    return tensor->bytes;
}

}  // namespace ai
