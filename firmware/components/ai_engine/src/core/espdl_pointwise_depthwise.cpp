#include "espdl_pointwise_depthwise.hpp"

#include <algorithm>
#include <climits>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "dl_base_conv2d.hpp"
#include "dl_base_depthwise_conv2d.hpp"
#include "dl_module_base.hpp"
#include "dl_tool.hpp"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "fbs_model.hpp"
#include "sdkconfig.h"

extern "C" void ai_engine_clamp_s8_esp32s3(int8_t *values, int32_t vectors, const int8_t *top);

namespace ai {

namespace {

const char *TAG = "pointwise_depthwise";

constexpr int kSpatialDims = 2;
constexpr int kChannelStep = 16;
constexpr size_t kVectorAlign = 16;
constexpr int kNoClamp = INT8_MAX;
// A wider band contends for the data cache with the rows it reads and writes (KEHOACH 3.7).
constexpr size_t kBandBytes = CONFIG_ESP32S3_DATA_CACHE_SIZE / 8;

// One band serves every PointwiseDepthwise: esp-dl runs one module at a time and only ai_task runs models.
struct Band {
    int8_t *rows = nullptr;
    size_t bytes = 0;
    int users = 0;
};

Band shared_band;

void reserve_shared_band(size_t bytes) noexcept
{
    if (bytes <= shared_band.bytes) {
        return;
    }
    heap_caps_free(shared_band.rows);
    shared_band.rows = static_cast<int8_t *>(heap_caps_aligned_calloc(kVectorAlign, 1, bytes, MALLOC_CAP_SPIRAM));
    shared_band.bytes = shared_band.rows != nullptr ? bytes : 0;
}

dl::activation_type_t activation_of(const std::string &name)
{
    if (name == "PRelu") {
        return dl::PReLU;
    }
    return name == "Relu" ? dl::ReLU : dl::Linear;
}

// Where one convolution's parameters sit among the node's inputs: filter, bias if any, slope if PReLU.
struct Part {
    int filter;
    int bias;
    int slope;
    dl::activation_type_t activation;
};

Part part_at(int first, int count, dl::activation_type_t activation)
{
    const bool sloped = activation == dl::PReLU;
    const bool biased = count - 1 - (sloped ? 1 : 0) == 1;
    return {first, biased ? first + 1 : -1, sloped ? first + count - 1 : -1, activation};
}

// Inputs as esp_ppq_patches.pointwise_depthwise_from writes them: x, the 1x1 convolution's parameters,
// then the depthwise one's; the middle tensor between them is never written out, its exponent rides along.
class PointwiseDepthwise final : public dl::module::Module {
public:
    PointwiseDepthwise(const char *name, std::vector<int> kernel, std::vector<int> pads, std::vector<int> strides,
                       Part pointwise, Part depthwise, int middle_exponent, int clip_max) :
        Module(name, dl::MODULE_NON_INPLACE, dl::QUANT_TYPE_SYMM_8BIT),
        kernel_(std::move(kernel)),
        pads_(std::move(pads)),
        strides_(std::move(strides)),
        pointwise_(pointwise),
        depthwise_(depthwise),
        middle_exponent_(middle_exponent),
        top_(static_cast<int8_t>(clip_max))
    {
        ++shared_band.users;
    }

    ~PointwiseDepthwise() override
    {
        if (--shared_band.users == 0) {
            heap_caps_free(shared_band.rows);
            shared_band = {};
        }
    }

    PointwiseDepthwise(const PointwiseDepthwise &) = delete;
    PointwiseDepthwise &operator=(const PointwiseDepthwise &) = delete;

    std::vector<std::vector<int>> get_output_shape(std::vector<std::vector<int>> &input_shapes) override
    {
        const std::vector<int> &x = input_shapes[0];
        const std::vector<int> &w = input_shapes[pointwise_.filter];
        std::vector<int> y = x;
        y[1] = (x[1] + pads_[0] + pads_[1] - kernel_[0]) / strides_[0] + 1;
        y[2] = (x[2] + pads_[2] + pads_[3] - kernel_[1]) / strides_[1] + 1;
        y[3] = w[3];
        // esp-dl's planner asks for shapes while the model is built, so the band is reserved then.
        reserve_band(static_cast<size_t>(x[2]) * w[3], x[1]);
        return {y};
    }

    void forward(dl::ModelContext *context, dl::runtime_mode_t) override
    {
        dl::TensorBase *x = context->get_tensor(m_inputs_index[0]);
        dl::TensorBase *y = context->get_tensor(m_outputs_index[0]);
        const size_t row_bytes = static_cast<size_t>(x->shape[2]) * y->shape[3];
        int8_t *band = shared_band.rows;
        if (band == nullptr || row_bytes * band_rows_ > shared_band.bytes) {
            ESP_LOGE(TAG, "%s: %d rows of %u bytes do not fit the band", name, band_rows_,
                     static_cast<unsigned>(row_bytes));
            return;
        }
        if (!built_ && !build(context, x, y, band)) {
            return;
        }
        const int in_h = x->shape[1];
        const int out_h = y->shape[1];
        const size_t in_row_bytes = static_cast<size_t>(x->shape[2]) * x->shape[3];
        const size_t out_row_bytes = static_cast<size_t>(y->shape[2]) * y->shape[3];
        const int out_band = band_rows_ >= in_h ? out_h : (band_rows_ - kernel_[0]) / strides_[0] + 1;
        int8_t *xs = x->get_element_ptr<int8_t>();
        int8_t *ys = y->get_element_ptr<int8_t>();
        int held_lo = 0;
        int held_hi = 0;
        for (int oy0 = 0; oy0 < out_h; oy0 += out_band) {
            const int oy1 = std::min(out_h, oy0 + out_band);
            const int want_lo = oy0 * strides_[0] - pads_[0];
            const int want_hi = (oy1 - 1) * strides_[0] - pads_[0] + kernel_[0];
            const int lo = std::max(0, want_lo);
            const int hi = std::min(in_h, want_hi);
            int from = lo;
            if (held_lo <= lo && lo < held_hi) {
                shift_rows(band, lo - held_lo, held_hi - lo, row_bytes);
                from = held_hi;
            }
            if (from < hi) {
                dl::base::ArgsType<int8_t> pointwise = pointwise_once_;
                pointwise.input_element = xs + from * in_row_bytes;
                pointwise.output_element = band + (from - lo) * row_bytes;
                pointwise.input_height = hi - from;
                pointwise.output_height = hi - from;
                dl::base::conv2d<int8_t, int32_t, int32_t>(&pointwise);
            }
            held_lo = lo;
            held_hi = hi;
            // esp-dl's shell rewrites the filter size in its args around the padding, so each band runs a copy.
            dl::base::ArgsType<int8_t> depthwise = depthwise_once_;
            depthwise.input_element = band;
            depthwise.input_height = hi - lo;
            depthwise.padding_h_head = lo - want_lo;
            depthwise.padding_h_tail = want_hi - hi;
            depthwise.output_element = ys + oy0 * out_row_bytes;
            depthwise.output_height = oy1 - oy0;
            dl::base::depthwise_conv2d<int8_t, int32_t, int32_t>(&depthwise);
            if (top_ != kNoClamp) {
                ai_engine_clamp_s8_esp32s3(ys + oy0 * out_row_bytes, (oy1 - oy0) * out_row_bytes / kVectorAlign,
                                           &top_);
            }
        }
    }

    void print() override
    {
        ESP_LOGI(TAG, "kernel: %s, pads: %s, strides: %s, band rows: %d, clip max: %d, quant_type: %s.",
                 dl::vector_to_string(kernel_).c_str(), dl::vector_to_string(pads_).c_str(),
                 dl::vector_to_string(strides_).c_str(), band_rows_, top_, dl::quant_type_to_string(quant_type));
    }

    static dl::module::Module *deserialize(fbs::FbsModel *fbs_model, std::string node_name)
    {
        std::vector<int> kernel;
        std::vector<int> pads;
        std::vector<int> strides;
        std::vector<int> dilations;
        std::string activation;
        std::string pointwise_activation;
        int pointwise_inputs = 0;
        int middle_exponent = 0;
        int depthwise_inputs = 0;
        int clip_max = kNoClamp;
        dl::quant_type_t quant_type = dl::QUANT_TYPE_NONE;
        fbs_model->get_operation_attribute(node_name, "kernel_shape", kernel);
        fbs_model->get_operation_attribute(node_name, "pads", pads);
        fbs_model->get_operation_attribute(node_name, "strides", strides);
        fbs_model->get_operation_attribute(node_name, "dilations", dilations);
        fbs_model->get_operation_attribute(node_name, "activation", activation);
        fbs_model->get_operation_attribute(node_name, "pointwise_activation", pointwise_activation);
        fbs_model->get_operation_attribute(node_name, "pointwise_inputs", pointwise_inputs);
        fbs_model->get_operation_attribute(node_name, "middle_exponent", middle_exponent);
        fbs_model->get_operation_attribute(node_name, "depthwise_inputs", depthwise_inputs);
        fbs_model->get_operation_attribute(node_name, "clip_max", clip_max);
        fbs_model->get_operation_attribute(node_name, "quant_type", quant_type);
        if (pads.empty()) {
            pads.assign(2 * kSpatialDims, 0);
        }
        const std::vector<int> unit(kSpatialDims, 1);
        if (quant_type != dl::QUANT_TYPE_SYMM_8BIT || kernel.size() != kSpatialDims ||
            pads.size() != 2 * kSpatialDims || strides.size() != kSpatialDims ||
            (!dilations.empty() && dilations != unit) || pointwise_inputs < 1 || depthwise_inputs < 1 ||
            clip_max < 0 || clip_max > kNoClamp) {
            ESP_LOGE(TAG, "%s: only an int8 1x1 convolution and its depthwise reader run joined", node_name.c_str());
            return nullptr;
        }
        const Part pointwise = part_at(1, pointwise_inputs, activation_of(pointwise_activation));
        const Part depthwise = part_at(1 + pointwise_inputs, depthwise_inputs, activation_of(activation));
        // ONNX orders pads [top, left, bottom, right]; esp-dl's kernels read [top, bottom, left, right].
        return new PointwiseDepthwise(node_name.c_str(), std::move(kernel), {pads[0], pads[2], pads[1], pads[3]},
                                      std::move(strides), pointwise, depthwise, middle_exponent, clip_max);
    }

private:
    dl::TensorBase *tensor(dl::ModelContext *context, int input) const
    {
        return input < 0 ? nullptr : context->get_tensor(m_inputs_index[input]);
    }

    void slope_into(dl::ModelContext *context, const Part &part, dl::base::ArgsType<int8_t> *args) const
    {
        if (part.activation != dl::PReLU) {
            return;
        }
        dl::TensorBase *slope = tensor(context, part.slope);
        args->activation_alpha_ptr = slope->get_element_ptr();
        // EE.VPRELU.S8 shifts the int8 product right; input and output share one exponent.
        args->activation_shift = -slope->get_exponent();
    }

    bool build(dl::ModelContext *context, dl::TensorBase *x, dl::TensorBase *y, int8_t *band)
    {
        const int width = x->shape[2];
        const int channels = y->shape[3];
        const bool misaligned = reinterpret_cast<uintptr_t>(y->get_element_ptr()) % kVectorAlign != 0;
        if (channels % kChannelStep != 0 || x->shape[3] % kChannelStep != 0 || (top_ != kNoClamp && misaligned)) {
            ESP_LOGE(TAG, "%s: %d channels in, %d out, not on 16-byte vectors", name, x->shape[3], channels);
            return false;
        }
        if (dl::TensorBase *bias = tensor(context, pointwise_.bias)) {
            bias->reset_bias_layout(quant_type, false);
        }
        if (dl::TensorBase *bias = tensor(context, depthwise_.bias)) {
            bias->reset_bias_layout(quant_type, true);
        }
        dl::TensorBase middle({1, band_rows_, width, channels}, band, middle_exponent_, x->get_dtype(), false,
                              MALLOC_CAP_SPIRAM);
        dl::base::ConvOpArgs<int8_t> pointwise_args(&middle, x, no_pads_, tensor(context, pointwise_.filter), ones_,
                                                    ones_, 1, tensor(context, pointwise_.bias), pointwise_.activation,
                                                    nullptr, dl::RUNTIME_MODE_SINGLE_CORE);
        dl::base::ConvOpArgs<int8_t> depthwise_args(y, &middle, pads_, tensor(context, depthwise_.filter), strides_,
                                                    ones_, channels, tensor(context, depthwise_.bias),
                                                    depthwise_.activation, nullptr, dl::RUNTIME_MODE_SINGLE_CORE);
        pointwise_once_ = pointwise_args.get_args(0);
        depthwise_once_ = depthwise_args.get_args(0);
        // The args outlive their ConvOpArgs, which frees the per-channel shift table it owns.
        if (pointwise_once_.mac_shift == INT_MIN || depthwise_once_.mac_shift == INT_MIN) {
            ESP_LOGE(TAG, "%s: only per-tensor exponents run joined", name);
            return false;
        }
        slope_into(context, pointwise_, &pointwise_once_);
        slope_into(context, depthwise_, &depthwise_once_);
        built_ = true;
        return true;
    }

    // Each copy moves at most `by` rows, so its source and destination never overlap.
    static void shift_rows(int8_t *band, int by, int rows, size_t row_bytes) noexcept
    {
        for (int r = 0; by > 0 && r < rows; r += by) {
            dl::tool::copy_memory(band + r * row_bytes, band + (r + by) * row_bytes,
                                  std::min(by, rows - r) * row_bytes);
        }
    }

    void reserve_band(size_t row_bytes, int height) noexcept
    {
        const int fitting = static_cast<int>(kBandBytes / std::max<size_t>(row_bytes, 1));
        band_rows_ = std::min(height, std::max(kernel_[0], fitting));
        reserve_shared_band(row_bytes * band_rows_);
    }

    const std::vector<int> kernel_;
    std::vector<int> pads_;
    const std::vector<int> strides_;
    const Part pointwise_;
    const Part depthwise_;
    const int middle_exponent_;
    const int8_t top_;
    std::vector<int> no_pads_ = std::vector<int>(2 * kSpatialDims, 0);
    const std::vector<int> ones_ = std::vector<int>(kSpatialDims, 1);
    int band_rows_ = 0;
    dl::base::ArgsType<int8_t> pointwise_once_ = {};
    dl::base::ArgsType<int8_t> depthwise_once_ = {};
    bool built_ = false;
};

}  // namespace

dl::module::Module *pointwise_depthwise_from(fbs::FbsModel *fbs_model, std::string node_name)
{
    return PointwiseDepthwise::deserialize(fbs_model, std::move(node_name));
}

}  // namespace ai
