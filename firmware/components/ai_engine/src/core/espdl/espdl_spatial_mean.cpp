#include "core/espdl/espdl_spatial_mean.hpp"

#include <cstddef>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "dl_base_pool2d.hpp"
#include "dl_base_tie728.h"
#include "dl_define.hpp"
#include "dl_module_base.hpp"
#include "dl_tool.hpp"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "fbs_model.hpp"

namespace ai {

namespace {

const char *TAG = "spatial_mean";

constexpr int kChannelStep = 16;
constexpr size_t kVectorAlign = 16;
constexpr int kLaneBits = 20;
// esp-dl's sum kernel dumps each 16 channels' QACC as 64 bytes: lanes 0-7 from word 0, lanes 8-15 from word 8.
constexpr int kDumpWords = 16;
constexpr int kHalfLanes = 8;
constexpr int kHalfWords = 8;
// 128 * pixels stays inside QACC's 20-bit lanes, as esp-dl's avg_pool2d requires of its sum kernel.
constexpr int kMaxPixels = 4095;

int32_t lane_of(const uint32_t *dump, int lane) noexcept
{
    const uint32_t *half = dump + (lane / kHalfLanes) * kHalfWords;
    const int bit = (lane % kHalfLanes) * kLaneBits;
    const uint64_t pair = half[bit / 32] | (static_cast<uint64_t>(half[bit / 32 + 1]) << 32);
    const uint32_t raw = static_cast<uint32_t>(pair >> (bit % 32)) & ((1u << kLaneBits) - 1);
    return static_cast<int32_t>(raw << (32 - kLaneBits)) >> (32 - kLaneBits);
}

// Inputs as esp_ppq_patches.spatial_mean_from writes them: x [1, H, W, C] alone; the output is [1, 1, 1, C].
class SpatialMean final : public dl::module::Module {
public:
    explicit SpatialMean(const char *name) : Module(name, dl::MODULE_NON_INPLACE, dl::QUANT_TYPE_SYMM_8BIT) {}

    ~SpatialMean() override { heap_caps_free(dump_); }

    SpatialMean(const SpatialMean &) = delete;
    SpatialMean &operator=(const SpatialMean &) = delete;

    std::vector<std::vector<int>> get_output_shape(std::vector<std::vector<int>> &input_shapes) override
    {
        const std::vector<int> &x = input_shapes[0];
        const size_t bytes = static_cast<size_t>(x[3] + kChannelStep - 1) / kChannelStep * kDumpWords * 4;
        // esp-dl's planner asks for shapes while the model is built, so the dump is reserved then.
        if (bytes > dump_bytes_) {
            heap_caps_free(dump_);
            dump_ = static_cast<uint32_t *>(heap_caps_aligned_calloc(kVectorAlign, 1, bytes, MALLOC_CAP_SPIRAM));
            dump_bytes_ = dump_ != nullptr ? bytes : 0;
        }
        return {{x[0], 1, 1, x[3]}};
    }

    void forward(dl::ModelContext *context, dl::runtime_mode_t) override
    {
        dl::TensorBase *x = context->get_tensor(m_inputs_index[0]);
        dl::TensorBase *y = context->get_tensor(m_outputs_index[0]);
        const int channels = x->shape[3];
        const int pixels = x->shape[1] * x->shape[2];
        int8_t *xs = x->get_element_ptr<int8_t>();
        if (channels % kChannelStep != 0 || pixels > kMaxPixels || dump_ == nullptr ||
            reinterpret_cast<uintptr_t>(xs) % kVectorAlign != 0) {
            ESP_LOGE(TAG, "%s: %d pixels of %d channels do not sum in QACC", name, pixels, channels);
            return;
        }
        if (!built_) {
            args_ = dl::base::get_pool_args<int8_t>(y, x, {0, 0, 0, 0}, {x->shape[1], x->shape[2]}, {1, 1},
                                                    dl::RUNTIME_MODE_SINGLE_CORE)[0];
            built_ = true;
        }
        dl_tie728_s8_avg_pool2d_hwc_sum(reinterpret_cast<int32_t *>(dump_), xs, &args_);
        // The very types and order of esp-dl 3.3.11's ReduceMean, so the float rounds the same way.
        const size_t count = static_cast<size_t>(pixels);
        const float input_scale = DL_SCALE(x->get_exponent());
        const float output_scale = DL_RESCALE(y->get_exponent());
        int8_t *ys = y->get_element_ptr<int8_t>();
        for (int c = 0; c < channels; ++c) {
            const int32_t tmp = lane_of(dump_ + c / kChannelStep * kDumpWords, c % kChannelStep);
            int8_t ret = 0;
            dl::tool::truncate(ret, dl::tool::round(tmp * input_scale / count * output_scale));
            ys[c] = ret;
        }
    }

    void print() override { ESP_LOGI(TAG, "quant_type: %s.", dl::quant_type_to_string(quant_type)); }

    static dl::module::Module *deserialize(fbs::FbsModel *fbs_model, std::string node_name)
    {
        dl::quant_type_t quant_type = dl::QUANT_TYPE_NONE;
        fbs_model->get_operation_attribute(node_name, "quant_type", quant_type);
        if (quant_type != dl::QUANT_TYPE_SYMM_8BIT) {
            ESP_LOGE(TAG, "%s: only an int8 spatial mean sums in QACC", node_name.c_str());
            return nullptr;
        }
        return new SpatialMean(node_name.c_str());
    }

private:
    uint32_t *dump_ = nullptr;
    size_t dump_bytes_ = 0;
    dl::base::PoolArgsType<int8_t> args_ = {};
    bool built_ = false;
};

}  // namespace

dl::module::Module *spatial_mean_from(fbs::FbsModel *fbs_model, std::string node_name)
{
    return SpatialMean::deserialize(fbs_model, std::move(node_name));
}

}  // namespace ai
