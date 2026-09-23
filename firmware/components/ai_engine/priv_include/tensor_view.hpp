/** One int8 tensor as the post-processing reads it, whichever runtime owns it.
 *  Real value = (q - zero_point) * scale; ESP-DL's views carry zero_point 0 and a
 *  power-of-two scale (KEHOACH 3 layer 4). dims are NHWC, rank of them in use.
 *  @ctx any | non-owning: valid while the model that holds the data lives
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace ai {

constexpr int kMaxRank = 4;

struct TensorView {
    int8_t *data = nullptr;
    int rank = 0;
    int dims[kMaxRank] = {};
    size_t bytes = 0;
    float scale = 0.0f;
    int zero_point = 0;

    bool valid() const noexcept { return data != nullptr; }
    int dim(int axis) const noexcept { return axis >= 0 && axis < rank ? dims[axis] : 0; }
};

}  // namespace ai
