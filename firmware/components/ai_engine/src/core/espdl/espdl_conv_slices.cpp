#include "core/espdl/espdl_conv_slices.hpp"

#include <string>
#include <utility>
#include <vector>

#include "dl_base_conv2d.hpp"
#include "dl_module_base.hpp"
#include "esp_log.h"
#include "fbs_model.hpp"

namespace ai {

namespace {

const char *TAG = "conv_slices";

constexpr int kSpatialDims = 2;

// Inputs as esp_ppq_patches.slice_into writes them: x, then per slice its filter, its bias when the
// Conv has one, and its slope when the slices carry a joined PReLU.
class ConvSlices final : public dl::module::Module {
public:
    ConvSlices(const char *name, std::vector<int> slices, bool prelu) :
        Module(name, dl::MODULE_NON_INPLACE, dl::QUANT_TYPE_SYMM_8BIT), slices_(std::move(slices)), prelu_(prelu)
    {
    }

    std::vector<std::vector<int>> get_output_shape(std::vector<std::vector<int>> &input_shapes) override
    {
        std::vector<int> y = input_shapes[0];
        y[3] = 0;
        for (const int channels : slices_) {
            y[3] += channels;
        }
        return {y};
    }

    void forward(dl::ModelContext *context, dl::runtime_mode_t) override
    {
        dl::TensorBase *input = context->get_tensor(m_inputs_index[0]);
        dl::TensorBase *output = context->get_tensor(m_outputs_index[0]);
        const size_t per_slice = (m_inputs_index.size() - 1) / slices_.size();
        const bool has_bias = per_slice == (prelu_ ? 3u : 2u);
        const int width = output->shape[2];
        const int channels = output->shape[3];
        int8_t *base = output->get_element_ptr<int8_t>();
        int start = 0;
        for (size_t i = 0; i < slices_.size(); ++i) {
            const int *slice = &m_inputs_index[1 + i * per_slice];
            dl::TensorBase *bias = has_bias ? context->get_tensor(slice[1]) : nullptr;
            if (bias != nullptr && !biases_laid_) {
                bias->reset_bias_layout(quant_type, false);
            }
            dl::TensorBase part({output->shape[0], output->shape[1], width, slices_[i]}, base + start,
                                output->get_exponent(), output->get_dtype(), false, output->caps);
            // Two cores would split by rows with the slice's own row stride; AI keeps one core (KEHOACH 5).
            dl::base::ConvOpArgs<int8_t> args(&part, input, pads_, context->get_tensor(slice[0]), ones_, ones_, 1,
                                              bias, prelu_ ? dl::PReLU : dl::Linear, nullptr,
                                              dl::RUNTIME_MODE_SINGLE_CORE);
            dl::base::ArgsType<int8_t> &run = args.get_args(0);
            run.output_x_offset = channels;
            run.output_y_offset = channels * width;
            if (prelu_) {
                dl::TensorBase *slope = context->get_tensor(slice[per_slice - 1]);
                run.activation_alpha_ptr = slope->get_element_ptr();
                run.activation_shift = -slope->get_exponent();
            }
            dl::base::conv2d<int8_t, int32_t, int32_t>(&run);
            start += slices_[i];
        }
        biases_laid_ = true;
    }

    void print() override
    {
        ESP_LOGI(TAG, "slices: %s, PReLU: %s, quant_type: %s.", dl::vector_to_string(slices_).c_str(),
                 prelu_ ? "joined" : "none", dl::quant_type_to_string(quant_type));
    }

    static dl::module::Module *deserialize(fbs::FbsModel *fbs_model, std::string node_name)
    {
        std::vector<int> slices;
        std::vector<int> kernel;
        std::vector<int> strides;
        std::string activation;
        dl::quant_type_t quant_type = dl::QUANT_TYPE_NONE;
        fbs_model->get_operation_attribute(node_name, "slices", slices);
        fbs_model->get_operation_attribute(node_name, "kernel_shape", kernel);
        fbs_model->get_operation_attribute(node_name, "strides", strides);
        fbs_model->get_operation_attribute(node_name, "activation", activation);
        fbs_model->get_operation_attribute(node_name, "quant_type", quant_type);
        const std::vector<int> unit(kSpatialDims, 1);
        if (quant_type != dl::QUANT_TYPE_SYMM_8BIT || slices.empty() || kernel != unit || strides != unit) {
            ESP_LOGE(TAG, "%s: only an int8 1x1 convolution runs as slices", node_name.c_str());
            return nullptr;
        }
        return new ConvSlices(node_name.c_str(), std::move(slices), activation == "PRelu");
    }

private:
    std::vector<int> slices_;
    const bool prelu_;
    std::vector<int> pads_ = std::vector<int>(2 * kSpatialDims, 0);
    const std::vector<int> ones_ = std::vector<int>(kSpatialDims, 1);
    bool biases_laid_ = false;
};

}  // namespace

dl::module::Module *conv_slices_from(fbs::FbsModel *fbs_model, std::string node_name)
{
    return ConvSlices::deserialize(fbs_model, std::move(node_name));
}

}  // namespace ai
