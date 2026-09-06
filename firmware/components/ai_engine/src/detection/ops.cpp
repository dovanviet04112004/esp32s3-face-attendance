#include "detect_model.hpp"

#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"

namespace ai {

namespace {

// AllOpsResolver would link kernels this graph never reaches (KEHOACH 6).
tflite::MicroMutableOpResolver<6> s_resolver;
bool s_registered;

}

tflite::MicroOpResolver &detect_ops() noexcept
{
    if (!s_registered) {
        s_resolver.AddAdd();
        s_resolver.AddConv2D();
        s_resolver.AddDepthwiseConv2D();
        s_resolver.AddMaxPool2D();
        s_resolver.AddPad();
        s_resolver.AddResizeNearestNeighbor();
        s_registered = true;
    }
    return s_resolver;
}

}  // namespace ai
