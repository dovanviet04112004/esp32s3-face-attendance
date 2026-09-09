#include "recog_model.hpp"

namespace ai {

size_t RecogModel::embedding(int8_t *out, size_t cap_bytes, float *scale) noexcept
{
    return normalized_int8(output(0), out, cap_bytes, scale);
}

}  // namespace ai
