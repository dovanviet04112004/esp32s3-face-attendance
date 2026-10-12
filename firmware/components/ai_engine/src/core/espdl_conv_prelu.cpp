#include "espdl_conv_prelu.hpp"

#include <string>
#include <utility>
#include <vector>

#include "dl_base_conv2d.hpp"
#include "dl_base_depthwise_conv2d.hpp"
#include "dl_module_base.hpp"
#include "dl_module_creator.hpp"
#include "esp_log.h"

namespace ai {

namespace {

const char *TAG = "conv_prelu";

constexpr size_t kInputsWithBias = 4;
constexpr size_t kSpatialDims = 2;

// Inputs as esp_ppq_patches.fuse_prelu writes them: x, filter, bias when the Conv has one, slope.
class ConvPRelu final : public dl::module::Module {
public:
    ConvPRelu(const char *name, std::vector<int> pads, std::vector<int> dilations, std::vector<int> strides,
              int group) :
        Module(name, dl::MODULE_NON_INPLACE, dl::QUANT_TYPE_SYMM_8BIT),
        pads_(std::move(pads)),
        dilations_(std::move(dilations)),
        strides_(std::move(strides)),
        group_(group)
    {
    }

    std::vector<std::vector<int>> get_output_shape(std::vector<std::vector<int>> &input_shapes) override
    {
        const std::vector<int> &x = input_shapes[0];
        const std::vector<int> &w = input_shapes[1];
        std::vector<int> y = x;
        y[1] = (x[1] + pads_[0] + pads_[1] - dilations_[0] * (w[0] - 1) - 1) / strides_[0] + 1;
        y[2] = (x[2] + pads_[2] + pads_[3] - dilations_[1] * (w[1] - 1) - 1) / strides_[1] + 1;
        y[3] = group_ == 1 ? w[3] : x[3];
        return {y};
    }

    void forward(dl::ModelContext *context, dl::runtime_mode_t mode) override
    {
        dl::TensorBase *bias =
            m_inputs_index.size() == kInputsWithBias ? context->get_tensor(m_inputs_index[2]) : nullptr;
        if (bias != nullptr && !bias_laid_) {
            bias->reset_bias_layout(quant_type, group_ != 1);
            bias_laid_ = true;
        }
        dl::TensorBase *slope = context->get_tensor(m_inputs_index.back());
        dl::base::ConvOpArgs<int8_t> args(context->get_tensor(m_outputs_index[0]),
                                          context->get_tensor(m_inputs_index[0]), pads_,
                                          context->get_tensor(m_inputs_index[1]), strides_, dilations_, group_, bias,
                                          dl::PReLU, nullptr, mode);
        for (size_t i = 0; i < args.size(); ++i) {
            args.get_args(i).activation_alpha_ptr = slope->get_element_ptr();
            // EE.VPRELU.S8 shifts the int8 product right; input and output share one exponent.
            args.get_args(i).activation_shift = -slope->get_exponent();
        }
        if (args.size() == 1) {
            forward_args(&args.get_args(0));
        } else if (args.size() == 2) {
            dl::module::module_forward_dual_core(this, &args.get_args(0), &args.get_args(1));
        } else {
            ESP_LOGE(TAG, "%s: esp-dl split the convolution into %u tasks", name, static_cast<unsigned>(args.size()));
        }
    }

    void forward_args(void *args) override
    {
        if (group_ == 1) {
            dl::base::conv2d<int8_t, int32_t, int32_t>(args);
        } else {
            dl::base::depthwise_conv2d<int8_t, int32_t, int32_t>(args);
        }
    }

    void print() override
    {
        ESP_LOGI(TAG, "pads: %s, strides: %s, dilations: %s, group: %d, quant_type: %s.",
                 dl::vector_to_string(pads_).c_str(), dl::vector_to_string(strides_).c_str(),
                 dl::vector_to_string(dilations_).c_str(), group_, dl::quant_type_to_string(quant_type));
    }

    static dl::module::Module *deserialize(fbs::FbsModel *fbs_model, std::string node_name)
    {
        std::vector<int> pads;
        std::vector<int> strides;
        std::vector<int> dilations;
        int group = 1;
        dl::quant_type_t quant_type = dl::QUANT_TYPE_NONE;
        fbs_model->get_operation_attribute(node_name, "pads", pads);
        fbs_model->get_operation_attribute(node_name, "strides", strides);
        fbs_model->get_operation_attribute(node_name, "dilations", dilations);
        fbs_model->get_operation_attribute(node_name, "group", group);
        fbs_model->get_operation_attribute(node_name, "quant_type", quant_type);
        if (pads.empty()) {
            pads.assign(2 * kSpatialDims, 0);
        }
        if (quant_type != dl::QUANT_TYPE_SYMM_8BIT || pads.size() != 2 * kSpatialDims ||
            strides.size() != kSpatialDims || dilations.size() != kSpatialDims) {
            ESP_LOGE(TAG, "%s: only an int8 2-D convolution carries a joined PReLU", node_name.c_str());
            return nullptr;
        }
        // ONNX orders pads [top, left, bottom, right]; esp-dl's kernels read [top, bottom, left, right].
        return new ConvPRelu(node_name.c_str(), {pads[0], pads[2], pads[1], pads[3]}, std::move(dilations),
                             std::move(strides), group);
    }

private:
    std::vector<int> pads_;
    std::vector<int> dilations_;
    std::vector<int> strides_;
    const int group_;
    bool bias_laid_ = false;
};

}  // namespace

void register_espdl_modules() noexcept
{
    dl::module::ModuleCreator *creator = dl::module::ModuleCreator::get_instance();
    // esp-dl fills its own table only while the table is empty, so it goes first.
    creator->register_dl_modules();
    creator->register_module("ConvPRelu", ConvPRelu::deserialize);
}

}  // namespace ai
