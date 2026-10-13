#include "espdl_channel_conv.hpp"

#include <algorithm>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "dl_module_base.hpp"
#include "esp_log.h"
#include "fbs_model.hpp"

namespace ai {

namespace {

const char *TAG = "channel_conv";

constexpr int32_t kInt8Low = -128;
constexpr int32_t kInt8High = 127;

int elements(const std::vector<int> &shape) noexcept
{
    int count = 1;
    for (const int dim : shape) {
        count *= dim;
    }
    return count;
}

// Half up, then int8 saturation, as esp-dl ends a convolution (tie728_s8_vector_round_result).
int8_t requantized(int32_t sum, int shift) noexcept
{
    const int32_t value = shift > 0 ? (sum + (1 << (shift - 1))) >> shift : sum << -shift;
    return static_cast<int8_t>(std::clamp(value, kInt8Low, kInt8High));
}

class ChannelConv final : public dl::module::Module {
public:
    ChannelConv(const char *name, int pad_head) :
        Module(name, dl::MODULE_NON_INPLACE, dl::QUANT_TYPE_SYMM_8BIT), pad_head_(pad_head)
    {
    }

    std::vector<std::vector<int>> get_output_shape(std::vector<std::vector<int>> &input_shapes) override
    {
        return {input_shapes[0]};
    }

    void forward(dl::ModelContext *context, dl::runtime_mode_t) override
    {
        dl::TensorBase *input = context->get_tensor(m_inputs_index[0]);
        dl::TensorBase *weight = context->get_tensor(m_inputs_index[1]);
        dl::TensorBase *output = context->get_tensor(m_outputs_index[0]);
        const int8_t *x = input->get_element_ptr<int8_t>();
        const int8_t *w = weight->get_element_ptr<int8_t>();
        int8_t *y = output->get_element_ptr<int8_t>();
        const int channels = elements(input->shape);
        const int taps = weight->shape.back();
        const int shift = output->get_exponent() - input->get_exponent() - weight->get_exponent();
        for (int c = 0; c < channels; ++c) {
            int32_t sum = 0;
            for (int t = 0; t < taps; ++t) {
                const int at = c + t - pad_head_;
                if (at >= 0 && at < channels) {
                    sum += static_cast<int32_t>(w[t]) * x[at];
                }
            }
            y[c] = requantized(sum, shift);
        }
    }

    void print() override
    {
        ESP_LOGI(TAG, "pad head: %d, quant_type: %s.", pad_head_, dl::quant_type_to_string(quant_type));
    }

    static dl::module::Module *deserialize(fbs::FbsModel *fbs_model, std::string node_name)
    {
        std::vector<int> kernel;
        std::vector<int> pads;
        dl::quant_type_t quant_type = dl::QUANT_TYPE_NONE;
        fbs_model->get_operation_attribute(node_name, "kernel_shape", kernel);
        fbs_model->get_operation_attribute(node_name, "pads", pads);
        fbs_model->get_operation_attribute(node_name, "quant_type", quant_type);
        if (quant_type != dl::QUANT_TYPE_SYMM_8BIT || kernel.size() != 1 || pads.size() != 2) {
            ESP_LOGE(TAG, "%s: only an int8 1-D kernel runs along the channels", node_name.c_str());
            return nullptr;
        }
        return new ChannelConv(node_name.c_str(), pads[0]);
    }

private:
    const int pad_head_;
};

}  // namespace

dl::module::Module *channel_conv_from(fbs::FbsModel *fbs_model, std::string node_name)
{
    return ChannelConv::deserialize(fbs_model, std::move(node_name));
}

}  // namespace ai
