#include "espdl_conv_im2col.hpp"

#include <climits>
#include <cstdint>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

#include "dl_base_conv2d.hpp"
#include "dl_module_base.hpp"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "fbs_model.hpp"

extern "C" void ai_engine_conv_row_s8_esp32s3(int8_t *out, const int8_t *patches, const int8_t *filter,
                                              const int32_t *run);

namespace ai {

namespace {

const char *TAG = "conv_im2col";

constexpr int kSpatialDims = 2;
constexpr int kChannelStep = 16;
constexpr size_t kVectorAlign = 16;
constexpr int kRgbChannels = 3;
constexpr int kRgbRowOf3x3Bytes = 3 * kRgbChannels;
constexpr int kNoClamp = INT8_MAX;

template <int kBytes>
inline void copy_bytes(int8_t *dst, const int8_t *src) noexcept
{
    if constexpr (kBytes > 0) {
        dst[0] = src[0];
        copy_bytes<kBytes - 1>(dst + 1, src + 1);
    }
}

void copy_run(int8_t *dst, const int8_t *src, int bytes) noexcept
{
    if (bytes == kRgbRowOf3x3Bytes) {
        copy_bytes<kRgbRowOf3x3Bytes>(dst, src);
    } else {
        std::memcpy(dst, src, bytes);
    }
}

// Inputs as esp_ppq_patches.im2col_from writes them: x, filter [1, 1, P, N] over P patch channels laid
// out kernel row, then column, then channel, bias when the Conv has one, slope when a PReLU is joined.
class ConvIm2col final : public dl::module::Module {
public:
    ConvIm2col(const char *name, std::vector<int> kernel, std::vector<int> pads, std::vector<int> strides,
               dl::activation_type_t activation, int clip_max) :
        Module(name, dl::MODULE_NON_INPLACE, dl::QUANT_TYPE_SYMM_8BIT),
        kernel_(std::move(kernel)),
        pads_(std::move(pads)),
        strides_(std::move(strides)),
        activation_(activation),
        top_(clip_max)
    {
    }

    ~ConvIm2col() override { heap_caps_free(patches_); }

    ConvIm2col(const ConvIm2col &) = delete;
    ConvIm2col &operator=(const ConvIm2col &) = delete;

    std::vector<std::vector<int>> get_output_shape(std::vector<std::vector<int>> &input_shapes) override
    {
        const std::vector<int> &x = input_shapes[0];
        const std::vector<int> &w = input_shapes[1];
        std::vector<int> y = x;
        y[1] = (x[1] + pads_[0] + pads_[1] - kernel_[0]) / strides_[0] + 1;
        y[2] = (x[2] + pads_[2] + pads_[3] - kernel_[1]) / strides_[1] + 1;
        y[3] = w[3];
        // esp-dl's planner asks for shapes while the model is built, so the patch row is reserved then.
        reserve_patches(static_cast<size_t>(y[2]) * w[2]);
        return {y};
    }

    void forward(dl::ModelContext *context, dl::runtime_mode_t) override
    {
        dl::TensorBase *input = context->get_tensor(m_inputs_index[0]);
        dl::TensorBase *filter = context->get_tensor(m_inputs_index[1]);
        dl::TensorBase *output = context->get_tensor(m_outputs_index[0]);
        const size_t params = m_inputs_index.size() - (activation_ == dl::PReLU ? 3 : 2);
        dl::TensorBase *bias = params == 1 ? context->get_tensor(m_inputs_index[2]) : nullptr;
        const int out_h = output->shape[1];
        const int out_w = output->shape[2];
        const int depth = filter->shape[2];
        if (!fits(input->shape[3], depth, output->shape[3], static_cast<size_t>(out_w) * depth)) {
            ESP_LOGE(TAG, "%s: %d channels in %dx%d patches do not fit %d patch channels", name,
                     input->shape[3], kernel_[0], kernel_[1], depth);
            return;
        }
        if (bias != nullptr && !bias_laid_) {
            bias->reset_bias_layout(quant_type, false);
            bias_laid_ = true;
        }
        dl::TensorBase row({1, 1, out_w, depth}, patches_, input->get_exponent(), input->get_dtype(), false,
                           MALLOC_CAP_SPIRAM);
        int8_t *out = output->get_element_ptr<int8_t>();
        dl::TensorBase line({1, 1, out_w, output->shape[3]}, out, output->get_exponent(), output->get_dtype(), false,
                            output->caps);
        dl::base::ConvOpArgs<int8_t> args(&line, &row, no_pads_, filter, ones_, ones_, 1, bias, activation_, nullptr,
                                          dl::RUNTIME_MODE_SINGLE_CORE);
        const dl::base::ArgsType<int8_t> &run = args.get_args(0);
        if (run.mac_shift == INT_MIN) {
            ESP_LOGE(TAG, "%s: only a per-tensor exponent runs over patches", name);
            return;
        }
        int32_t alpha = run.activation_alpha;
        int activation_shift = run.activation_shift;
        if (activation_ == dl::PReLU) {
            dl::TensorBase *slope = context->get_tensor(m_inputs_index.back());
            alpha = static_cast<int32_t>(reinterpret_cast<uintptr_t>(slope->get_element_ptr()));
            activation_shift = -slope->get_exponent();
        }
        const int kind = activation_ == dl::PReLU ? 2 : (activation_ == dl::ReLU ? 1 : 0);
        const int32_t row_run[] = {out_w,
                                   output->shape[3] / kChannelStep,
                                   depth / kChannelStep,
                                   run.mac_shift,
                                   static_cast<int32_t>(reinterpret_cast<uintptr_t>(run.bias_element)),
                                   kind,
                                   alpha,
                                   activation_shift,
                                   top_};
        const int8_t *weights = static_cast<const int8_t *>(run.filter_element);
        const int8_t *x = input->get_element_ptr<int8_t>();
        const int row_bytes = out_w * output->shape[3];
        for (int oy = 0; oy < out_h; ++oy) {
            gather(x, input->shape, oy, out_w, depth);
            ai_engine_conv_row_s8_esp32s3(out + oy * row_bytes, patches_, weights, row_run);
        }
    }

    void print() override
    {
        ESP_LOGI(TAG, "kernel: %s, pads: %s, strides: %s, activation: %s, clip max: %d, quant_type: %s.",
                 dl::vector_to_string(kernel_).c_str(), dl::vector_to_string(pads_).c_str(),
                 dl::vector_to_string(strides_).c_str(), dl::activation_type_to_string(activation_), top_,
                 dl::quant_type_to_string(quant_type));
    }

    static dl::module::Module *deserialize(fbs::FbsModel *fbs_model, std::string node_name)
    {
        std::vector<int> kernel;
        std::vector<int> pads;
        std::vector<int> strides;
        std::vector<int> dilations;
        std::string activation;
        int group = 1;
        int clip_max = kNoClamp;
        dl::quant_type_t quant_type = dl::QUANT_TYPE_NONE;
        fbs_model->get_operation_attribute(node_name, "kernel_shape", kernel);
        fbs_model->get_operation_attribute(node_name, "pads", pads);
        fbs_model->get_operation_attribute(node_name, "strides", strides);
        fbs_model->get_operation_attribute(node_name, "dilations", dilations);
        fbs_model->get_operation_attribute(node_name, "activation", activation);
        fbs_model->get_operation_attribute(node_name, "group", group);
        fbs_model->get_operation_attribute(node_name, "clip_max", clip_max);
        fbs_model->get_operation_attribute(node_name, "quant_type", quant_type);
        if (pads.empty()) {
            pads.assign(2 * kSpatialDims, 0);
        }
        const std::vector<int> unit(kSpatialDims, 1);
        if (quant_type != dl::QUANT_TYPE_SYMM_8BIT || group != 1 || kernel.size() != kSpatialDims ||
            pads.size() != 2 * kSpatialDims || strides.size() != kSpatialDims ||
            (!dilations.empty() && dilations != unit) || clip_max < 0 || clip_max > kNoClamp) {
            ESP_LOGE(TAG, "%s: only an int8 2-D ungrouped convolution runs over patches", node_name.c_str());
            return nullptr;
        }
        dl::activation_type_t type = dl::Linear;
        if (activation == "PRelu") {
            type = dl::PReLU;
        } else if (activation == "Relu") {
            type = dl::ReLU;
        }
        // ONNX orders pads [top, left, bottom, right]; esp-dl's kernels read [top, bottom, left, right].
        return new ConvIm2col(node_name.c_str(), std::move(kernel), {pads[0], pads[2], pads[1], pads[3]},
                              std::move(strides), type, clip_max);
    }

private:
    bool fits(int channels, int depth, int outputs, size_t row_bytes) const noexcept
    {
        return patches_ != nullptr && row_bytes <= patch_bytes_ && depth % kChannelStep == 0 &&
            outputs % kChannelStep == 0 && kernel_[0] * kernel_[1] * channels <= depth;
    }

    void reserve_patches(size_t bytes) noexcept
    {
        if (bytes <= patch_bytes_) {
            return;
        }
        heap_caps_free(patches_);
        patches_ = static_cast<int8_t *>(heap_caps_aligned_calloc(kVectorAlign, 1, bytes, MALLOC_CAP_SPIRAM));
        patch_bytes_ = patches_ != nullptr ? bytes : 0;
    }

    // Each pixel's patch takes depth bytes; the bytes past the kernel's stay zero from the calloc.
    void gather(const int8_t *x, const std::vector<int> &shape, int oy, int out_w, int depth) noexcept
    {
        const int in_h = shape[1];
        const int in_w = shape[2];
        const int channels = shape[3];
        const int run_bytes = kernel_[1] * channels;
        for (int ox = 0; ox < out_w; ++ox) {
            int8_t *patch = patches_ + ox * depth;
            const int ix0 = ox * strides_[1] - pads_[2];
            const bool inside = ix0 >= 0 && ix0 + kernel_[1] <= in_w;
            for (int ky = 0; ky < kernel_[0]; ++ky) {
                int8_t *dst = patch + ky * run_bytes;
                const int iy = oy * strides_[0] + ky - pads_[0];
                if (iy < 0 || iy >= in_h) {
                    std::memset(dst, 0, run_bytes);
                    continue;
                }
                const int8_t *src = x + (iy * in_w + ix0) * channels;
                if (inside) {
                    copy_run(dst, src, run_bytes);
                    continue;
                }
                for (int kx = 0; kx < kernel_[1]; ++kx) {
                    const int ix = ix0 + kx;
                    if (ix < 0 || ix >= in_w) {
                        std::memset(dst + kx * channels, 0, channels);
                    } else {
                        std::memcpy(dst + kx * channels, src + kx * channels, channels);
                    }
                }
            }
        }
    }

    const std::vector<int> kernel_;
    const std::vector<int> pads_;
    const std::vector<int> strides_;
    const dl::activation_type_t activation_;
    const int top_;
    std::vector<int> no_pads_ = std::vector<int>(2 * kSpatialDims, 0);
    const std::vector<int> ones_ = std::vector<int>(kSpatialDims, 1);
    int8_t *patches_ = nullptr;
    size_t patch_bytes_ = 0;
    bool bias_laid_ = false;
};

}  // namespace

dl::module::Module *conv_im2col_from(fbs::FbsModel *fbs_model, std::string node_name)
{
    return ConvIm2col::deserialize(fbs_model, std::move(node_name));
}

}  // namespace ai
