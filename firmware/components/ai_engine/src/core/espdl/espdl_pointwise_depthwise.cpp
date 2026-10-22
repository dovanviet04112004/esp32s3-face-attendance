#include "core/espdl/espdl_pointwise_depthwise.hpp"

#include <algorithm>
#include <array>
#include <climits>
#include <cstdint>
#include <cstring>
#include <optional>
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
extern "C" void ai_engine_conv_row_s8_esp32s3(int8_t *out, const int8_t *patches, const int8_t *filter,
                                              const int32_t *run);
extern "C" void ai_engine_max_pool_s8_esp32s3(int8_t *out, const int8_t *rows, const int32_t *run);

namespace ai {

namespace {

const char *TAG = "pointwise_depthwise";

constexpr int kSpatialDims = 2;
constexpr int kChannelStep = 16;
constexpr size_t kVectorAlignBytes = 16;
constexpr int kNoClamp = INT8_MAX;
constexpr size_t kRowRunWords = 9;
constexpr int kPool = 2;
// A wider band contends for the data cache with the rows it reads and writes (KEHOACH 3.7).
constexpr size_t kBandBytes = CONFIG_ESP32S3_DATA_CACHE_SIZE / 8;

using RowRun = std::array<int32_t, kRowRunWords>;

bool aligned(dl::TensorBase *tensor) noexcept
{
    return reinterpret_cast<uintptr_t>(tensor->get_element_ptr()) % kVectorAlignBytes == 0;
}

struct Band {
    int8_t *rows = nullptr;
    size_t bytes = 0;

    void reserve(size_t wanted) noexcept
    {
        if (wanted <= bytes) {
            return;
        }
        // Grown first: freeing the old block for a grow that fails would strip every module built so far.
        int8_t *grown =
            static_cast<int8_t *>(heap_caps_aligned_calloc(kVectorAlignBytes, 1, wanted, MALLOC_CAP_SPIRAM));
        if (grown == nullptr) {
            return;
        }
        heap_caps_free(rows);
        rows = grown;
        bytes = wanted;
    }

    void release() noexcept
    {
        heap_caps_free(rows);
        rows = nullptr;
        bytes = 0;
    }
};

// The bands serve every PointwiseDepthwise: esp-dl runs one module at a time and only ai_task runs models.
Band middle_band;
Band depthwise_band;
int band_users = 0;

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

constexpr Part kNoPart = {-1, -1, -1, dl::Linear};

Part part_at(int first, int count, dl::activation_type_t activation)
{
    const bool sloped = activation == dl::PReLU;
    const bool biased = count - 1 - (sloped ? 1 : 0) == 1;
    return {first, biased ? first + 1 : -1, sloped ? first + count - 1 : -1, activation};
}

// Inputs as esp_ppq_patches.pointwise_depthwise_from writes them: x, the 1x1 convolution's parameters, the
// depthwise one's, then the projection's when it joined; the tensors between them are never written out.
class PointwiseDepthwise final : public dl::module::Module {
public:
    PointwiseDepthwise(const char *name, std::vector<int> kernel, std::vector<int> pads, std::vector<int> strides,
                       Part pointwise, Part depthwise, Part project, int middle_exponent, int depthwise_exponent,
                       int clip_max, bool pooled) :
        Module(name, dl::MODULE_NON_INPLACE, dl::QUANT_TYPE_SYMM_8BIT),
        kernel_(std::move(kernel)),
        pads_(std::move(pads)),
        strides_(std::move(strides)),
        pointwise_(pointwise),
        depthwise_(depthwise),
        project_(project),
        middle_exponent_(middle_exponent),
        depthwise_exponent_(depthwise_exponent),
        top_(static_cast<int8_t>(clip_max)),
        pooled_(pooled)
    {
        ++band_users;
    }

    ~PointwiseDepthwise() override
    {
        heap_caps_free(pointwise_filter_);
        heap_caps_free(depthwise_filter_);
        if (--band_users == 0) {
            middle_band.release();
            depthwise_band.release();
        }
    }

    PointwiseDepthwise(const PointwiseDepthwise &) = delete;
    PointwiseDepthwise &operator=(const PointwiseDepthwise &) = delete;

    std::vector<std::vector<int>> get_output_shape(std::vector<std::vector<int>> &input_shapes) override
    {
        const std::vector<int> &x = input_shapes[0];
        kept_ = input_shapes[pointwise_.filter][3];
        channels_ = (kept_ + kChannelStep - 1) / kChannelStep * kChannelStep;
        depthwise_h_ = (x[1] + pads_[0] + pads_[1] - kernel_[0]) / strides_[0] + 1;
        depthwise_w_ = (x[2] + pads_[2] + pads_[3] - kernel_[1]) / strides_[1] + 1;
        std::vector<int> y = x;
        y[1] = pooled_ ? depthwise_h_ / kPool : depthwise_h_;
        y[2] = pooled_ ? depthwise_w_ / kPool : depthwise_w_;
        y[3] = projected() ? input_shapes[project_.filter][3] : kept_;
        // esp-dl's planner asks for shapes while the model is built, so the bands are reserved then.
        reserve_bands(x[1], x[2]);
        return {y};
    }

    void forward(dl::ModelContext *context, dl::runtime_mode_t) override
    {
        dl::TensorBase *x = context->get_tensor(m_inputs_index[0]);
        dl::TensorBase *y = context->get_tensor(m_outputs_index[0]);
        const size_t row_bytes = static_cast<size_t>(x->shape[2]) * channels_;
        const size_t depthwise_row_bytes = static_cast<size_t>(depthwise_w_) * channels_;
        int8_t *band = middle_band.rows;
        int8_t *staged = depthwise_band.rows;
        if (band == nullptr || row_bytes * band_rows_ > middle_band.bytes ||
            (staging() && (staged == nullptr || depthwise_row_bytes * out_band_ > depthwise_band.bytes))) {
            ESP_LOGE(TAG, "%s: %d rows of %u bytes do not fit the bands", name, band_rows_,
                     static_cast<unsigned>(row_bytes));
            return;
        }
        if (!built_ && !build(context, x, y, band, staged)) {
            return;
        }
        const int in_h = x->shape[1];
        const int out_h = depthwise_h_;
        const size_t in_row_bytes = static_cast<size_t>(x->shape[2]) * x->shape[3];
        const size_t out_row_bytes = static_cast<size_t>(y->shape[2]) * y->shape[3];
        int8_t *xs = x->get_element_ptr<int8_t>();
        int8_t *ys = y->get_element_ptr<int8_t>();
        int held_lo = 0;
        int held_hi = 0;
        for (int oy0 = 0; oy0 < out_h; oy0 += out_band_) {
            const int oy1 = std::min(out_h, oy0 + out_band_);
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
                pointwise_run_[0] = (hi - from) * x->shape[2];
                ai_engine_conv_row_s8_esp32s3(band + (from - lo) * row_bytes, xs + from * in_row_bytes,
                                              static_cast<const int8_t *>(pointwise_once_.filter_element),
                                              pointwise_run_.data());
            }
            held_lo = lo;
            held_hi = hi;
            int8_t *rows_out = staging() ? staged : ys + oy0 * out_row_bytes;
            // esp-dl's shell rewrites the filter size in its args around the padding, so each band runs a copy.
            dl::base::ArgsType<int8_t> depthwise = depthwise_once_;
            depthwise.input_element = band;
            depthwise.input_height = hi - lo;
            depthwise.padding_h_head = lo - want_lo;
            depthwise.padding_h_tail = want_hi - hi;
            depthwise.output_element = rows_out;
            depthwise.output_height = oy1 - oy0;
            dl::base::depthwise_conv2d<int8_t, int32_t, int32_t>(&depthwise);
            if (top_ != kNoClamp) {
                ai_engine_clamp_s8_esp32s3(rows_out, (oy1 - oy0) * depthwise_row_bytes / kVectorAlignBytes, &top_);
            }
            if (projected()) {
                project_run_[0] = (oy1 - oy0) * y->shape[2];
                ai_engine_conv_row_s8_esp32s3(ys + oy0 * out_row_bytes, staged,
                                              static_cast<const int8_t *>(project_once_.filter_element),
                                              project_run_.data());
            }
            if (pooled_ && oy1 - oy0 >= kPool) {
                pool_run_[0] = (oy1 - oy0) / kPool;
                ai_engine_max_pool_s8_esp32s3(ys + oy0 / kPool * out_row_bytes, staged, pool_run_.data());
            }
            if (narrowed()) {
                keep_channels(ys + oy0 * out_row_bytes, staged, (oy1 - oy0) * depthwise_w_, kept_, channels_);
            }
        }
    }

    void print() override
    {
        ESP_LOGI(TAG,
                 "kernel: %s, pads: %s, strides: %s, band rows: %d, projected: %d, clip max: %d, pooled: %d, "
                 "quant_type: %s.",
                 dl::vector_to_string(kernel_).c_str(), dl::vector_to_string(pads_).c_str(),
                 dl::vector_to_string(strides_).c_str(), band_rows_, projected(), top_, pooled_,
                 dl::quant_type_to_string(quant_type));
    }

    static dl::module::Module *deserialize(fbs::FbsModel *fbs_model, std::string node_name)
    {
        std::vector<int> kernel;
        std::vector<int> pads;
        std::vector<int> strides;
        std::vector<int> dilations;
        std::vector<int> pool;
        std::string activation;
        std::string pointwise_activation;
        std::string project_activation;
        int pointwise_inputs = 0;
        int depthwise_inputs = 0;
        int project_inputs = 0;
        int middle_exponent = 0;
        int depthwise_exponent = 0;
        int clip_max = kNoClamp;
        dl::quant_type_t quant_type = dl::QUANT_TYPE_NONE;
        fbs_model->get_operation_attribute(node_name, "kernel_shape", kernel);
        fbs_model->get_operation_attribute(node_name, "pads", pads);
        fbs_model->get_operation_attribute(node_name, "strides", strides);
        fbs_model->get_operation_attribute(node_name, "dilations", dilations);
        fbs_model->get_operation_attribute(node_name, "activation", activation);
        fbs_model->get_operation_attribute(node_name, "pointwise_activation", pointwise_activation);
        fbs_model->get_operation_attribute(node_name, "project_activation", project_activation);
        fbs_model->get_operation_attribute(node_name, "pointwise_inputs", pointwise_inputs);
        fbs_model->get_operation_attribute(node_name, "depthwise_inputs", depthwise_inputs);
        fbs_model->get_operation_attribute(node_name, "project_inputs", project_inputs);
        fbs_model->get_operation_attribute(node_name, "middle_exponent", middle_exponent);
        fbs_model->get_operation_attribute(node_name, "depthwise_exponent", depthwise_exponent);
        fbs_model->get_operation_attribute(node_name, "clip_max", clip_max);
        fbs_model->get_operation_attribute(node_name, "max_pool", pool);
        fbs_model->get_operation_attribute(node_name, "quant_type", quant_type);
        if (pads.empty()) {
            pads.assign(2 * kSpatialDims, 0);
        }
        const std::vector<int> unit(kSpatialDims, 1);
        if (quant_type != dl::QUANT_TYPE_SYMM_8BIT || kernel.size() != kSpatialDims ||
            pads.size() != 2 * kSpatialDims || strides.size() != kSpatialDims ||
            (!dilations.empty() && dilations != unit) || pointwise_inputs < 1 || depthwise_inputs < 1 ||
            project_inputs < 0 || clip_max < 0 || clip_max > kNoClamp ||
            (!pool.empty() && (pool != std::vector<int>(kSpatialDims, kPool) || project_inputs > 0))) {
            ESP_LOGE(TAG, "%s: only an int8 1x1 convolution and its depthwise reader run joined", node_name.c_str());
            return nullptr;
        }
        const Part pointwise = part_at(1, pointwise_inputs, activation_of(pointwise_activation));
        const Part depthwise = part_at(1 + pointwise_inputs, depthwise_inputs, activation_of(activation));
        const Part project = project_inputs == 0 ?
            kNoPart :
            part_at(1 + pointwise_inputs + depthwise_inputs, project_inputs, activation_of(project_activation));
        // ONNX orders pads [top, left, bottom, right]; esp-dl's kernels read [top, bottom, left, right].
        return new PointwiseDepthwise(node_name.c_str(), std::move(kernel), {pads[0], pads[2], pads[1], pads[3]},
                                      std::move(strides), pointwise, depthwise, project, middle_exponent,
                                      depthwise_exponent, clip_max, !pool.empty());
    }

private:
    bool projected() const noexcept { return project_.filter >= 0; }

    // The middle runs on whole 16-channel vectors; the zero channels past kept_ never leave the bands.
    bool narrowed() const noexcept { return kept_ != channels_; }

    // The depthwise writes its band to the second band when a projection, a max pool or a narrowing reads it.
    bool staging() const noexcept { return projected() || pooled_ || narrowed(); }

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

    bool build(dl::ModelContext *context, dl::TensorBase *x, dl::TensorBase *y, int8_t *band, int8_t *staged)
    {
        const bool vectors_out = !narrowed();
        if (x->shape[3] % kChannelStep != 0 || (vectors_out && y->shape[3] % kChannelStep != 0) || !aligned(x) ||
            (vectors_out && (top_ != kNoClamp || staging()) && !aligned(y)) ||
            (narrowed() && (projected() || pooled_ || pointwise_.activation == dl::PReLU ||
                            depthwise_.activation == dl::PReLU))) {
            ESP_LOGE(TAG, "%s: %d channels in, %d between, %d out, not on 16-byte vectors", name, x->shape[3], kept_,
                     y->shape[3]);
            return false;
        }
        dl::TensorBase *pointwise_filter = tensor(context, pointwise_.filter);
        dl::TensorBase *depthwise_filter = tensor(context, depthwise_.filter);
        dl::TensorBase *pointwise_bias = tensor(context, pointwise_.bias);
        dl::TensorBase *depthwise_bias = tensor(context, depthwise_.bias);
        if (narrowed() && !widen(pointwise_filter, depthwise_filter, pointwise_bias, depthwise_bias, x->shape[3])) {
            ESP_LOGE(TAG, "%s: no memory for the 16-channel copies of %d channels", name, kept_);
            return false;
        }
        std::optional<dl::TensorBase> wide_pointwise;
        std::optional<dl::TensorBase> wide_depthwise;
        if (narrowed()) {
            wide_pointwise.emplace(std::vector<int>{1, 1, x->shape[3], channels_}, pointwise_filter_,
                                   pointwise_filter->get_exponent(), pointwise_filter->get_dtype(), false,
                                   MALLOC_CAP_SPIRAM);
            wide_depthwise.emplace(std::vector<int>{kernel_[0], kernel_[1], channels_, 1}, depthwise_filter_,
                                   depthwise_filter->get_exponent(), depthwise_filter->get_dtype(), false,
                                   MALLOC_CAP_SPIRAM);
            pointwise_filter = &*wide_pointwise;
            depthwise_filter = &*wide_depthwise;
            pointwise_bias = pointwise_bias_ ? &*pointwise_bias_ : nullptr;
            depthwise_bias = depthwise_bias_ ? &*depthwise_bias_ : nullptr;
        }
        if (pointwise_bias != nullptr) {
            pointwise_bias->reset_bias_layout(quant_type, false);
        }
        if (depthwise_bias != nullptr) {
            depthwise_bias->reset_bias_layout(quant_type, true);
        }
        if (dl::TensorBase *bias = tensor(context, project_.bias)) {
            bias->reset_bias_layout(quant_type, false);
        }
        dl::TensorBase middle({1, band_rows_, x->shape[2], channels_}, band, middle_exponent_, x->get_dtype(), false,
                              MALLOC_CAP_SPIRAM);
        pointwise_once_ = pointwise_args(&middle, x, pointwise_filter, pointwise_bias, pointwise_.activation);
        if (staging()) {
            const int exponent = projected() ? depthwise_exponent_ : y->get_exponent();
            dl::TensorBase rows_out({1, out_band_, depthwise_w_, channels_}, staged, exponent, y->get_dtype(), false,
                                    MALLOC_CAP_SPIRAM);
            depthwise_once_ = depthwise_args(&rows_out, &middle, depthwise_filter, depthwise_bias);
            if (projected()) {
                project_once_ = pointwise_args(y, &rows_out, tensor(context, project_.filter),
                                               tensor(context, project_.bias), project_.activation);
            }
        } else {
            depthwise_once_ = depthwise_args(y, &middle, depthwise_filter, depthwise_bias);
        }
        // The args outlive their ConvOpArgs, which frees the per-channel shift table it owns.
        if (pointwise_once_.mac_shift == INT_MIN || depthwise_once_.mac_shift == INT_MIN ||
            (projected() && project_once_.mac_shift == INT_MIN)) {
            ESP_LOGE(TAG, "%s: only per-tensor exponents run joined", name);
            return false;
        }
        slope_into(context, pointwise_, &pointwise_once_);
        slope_into(context, depthwise_, &depthwise_once_);
        slope_into(context, project_, &project_once_);
        pointwise_run_ = row_run(pointwise_once_, pointwise_.activation, channels_, x->shape[3]);
        if (projected()) {
            project_run_ = row_run(project_once_, project_.activation, y->shape[3], channels_);
        }
        pool_run_ = {0, y->shape[2], channels_ / kChannelStep, depthwise_w_ * channels_};
        built_ = true;
        return true;
    }

    // The run of conv_row_s8_esp32s3.S for one 1x1 convolution; forward sets its pixel count a band at a time.
    static RowRun row_run(const dl::base::ArgsType<int8_t> &args, dl::activation_type_t activation, int outputs,
                          int inputs) noexcept
    {
        const bool sloped = activation == dl::PReLU;
        const int32_t alpha = sloped ? static_cast<int32_t>(reinterpret_cast<uintptr_t>(args.activation_alpha_ptr))
                                     : args.activation_alpha;
        return {0,
                outputs / kChannelStep,
                inputs / kChannelStep,
                args.mac_shift,
                static_cast<int32_t>(reinterpret_cast<uintptr_t>(args.bias_element)),
                sloped ? 2 : (activation == dl::ReLU ? 1 : 0),
                alpha,
                args.activation_shift,
                kNoClamp};
    }

    dl::base::ArgsType<int8_t> pointwise_args(dl::TensorBase *out, dl::TensorBase *in, dl::TensorBase *filter,
                                              dl::TensorBase *bias, dl::activation_type_t activation)
    {
        dl::base::ConvOpArgs<int8_t> args(out, in, no_pads_, filter, ones_, ones_, 1, bias, activation, nullptr,
                                          dl::RUNTIME_MODE_SINGLE_CORE);
        return args.get_args(0);
    }

    dl::base::ArgsType<int8_t> depthwise_args(dl::TensorBase *out, dl::TensorBase *in, dl::TensorBase *filter,
                                              dl::TensorBase *bias)
    {
        dl::base::ConvOpArgs<int8_t> args(out, in, pads_, filter, strides_, ones_, channels_, bias,
                                          depthwise_.activation, nullptr, dl::RUNTIME_MODE_SINGLE_CORE);
        return args.get_args(0);
    }

    // ESP-PPQ stores the channels past the last whole 16 as [channel][input] for a 1x1 filter and as
    // [tap][channel] for a depthwise one, and both biases as plain int32; the copies run 16 channels wide.
    bool widen(dl::TensorBase *pointwise_filter, dl::TensorBase *depthwise_filter, dl::TensorBase *pointwise_bias,
               dl::TensorBase *depthwise_bias, int inputs) noexcept
    {
        const int whole = kept_ / kChannelStep * kChannelStep;
        const int rest = kept_ - whole;
        const int taps = kernel_[0] * kernel_[1];
        heap_caps_free(pointwise_filter_);
        heap_caps_free(depthwise_filter_);
        pointwise_filter_ = static_cast<int8_t *>(
            heap_caps_aligned_calloc(kVectorAlignBytes, 1, static_cast<size_t>(inputs) * channels_, MALLOC_CAP_SPIRAM));
        depthwise_filter_ = static_cast<int8_t *>(
            heap_caps_aligned_calloc(kVectorAlignBytes, 1, static_cast<size_t>(taps) * channels_, MALLOC_CAP_SPIRAM));
        if (pointwise_filter_ == nullptr || depthwise_filter_ == nullptr) {
            return false;
        }
        const int8_t *pointwise = pointwise_filter->get_element_ptr<int8_t>();
        const int8_t *depthwise = depthwise_filter->get_element_ptr<int8_t>();
        std::memcpy(pointwise_filter_, pointwise, static_cast<size_t>(whole) * inputs);
        std::memcpy(depthwise_filter_, depthwise, static_cast<size_t>(whole) * taps);
        for (int lane = 0; lane < rest; ++lane) {
            for (int c = 0; c < inputs; ++c) {
                pointwise_filter_[whole * inputs + c * kChannelStep + lane] = pointwise[(whole + lane) * inputs + c];
            }
            for (int t = 0; t < taps; ++t) {
                depthwise_filter_[whole * taps + t * kChannelStep + lane] = depthwise[whole * taps + t * rest + lane];
            }
        }
        pointwise_bias_.reset();
        depthwise_bias_.reset();
        widen_bias(pointwise_bias, &pointwise_bias_);
        widen_bias(depthwise_bias, &depthwise_bias_);
        return true;
    }

    void widen_bias(dl::TensorBase *bias, std::optional<dl::TensorBase> *wide) const
    {
        if (bias == nullptr) {
            return;
        }
        std::vector<int32_t> values(channels_, 0);
        std::memcpy(values.data(), bias->get_element_ptr<int32_t>(), static_cast<size_t>(kept_) * sizeof(int32_t));
        wide->emplace(std::vector<int>{channels_}, values.data(), bias->get_exponent(), bias->get_dtype(), true,
                      MALLOC_CAP_SPIRAM);
    }

    static void keep_channels(int8_t *out, const int8_t *rows, int pixels, int kept, int channels) noexcept
    {
        for (int p = 0; p < pixels; ++p) {
            for (int c = 0; c < kept; ++c) {
                out[p * kept + c] = rows[p * channels + c];
            }
        }
    }

    // Each copy moves at most `by` rows, so its source and destination never overlap.
    static void shift_rows(int8_t *band, int by, int rows, size_t row_bytes) noexcept
    {
        for (int r = 0; by > 0 && r < rows; r += by) {
            dl::tool::copy_memory(band + r * row_bytes, band + (r + by) * row_bytes,
                                  std::min(by, rows - r) * row_bytes);
        }
    }

    void reserve_bands(int in_h, int in_w) noexcept
    {
        const size_t row_bytes = static_cast<size_t>(in_w) * channels_;
        const int fitting = static_cast<int>(kBandBytes / std::max<size_t>(row_bytes, 1));
        band_rows_ = std::min(in_h, std::max(kernel_[0], fitting));
        out_band_ = band_rows_ >= in_h ? depthwise_h_ : (band_rows_ - kernel_[0]) / strides_[0] + 1;
        // A max pool takes its output rows two at a time from each band.
        if (pooled_ && out_band_ < depthwise_h_ && out_band_ % kPool != 0) {
            out_band_ = out_band_ > 1 ? out_band_ - 1 : kPool;
            band_rows_ = std::min(in_h, std::max(band_rows_, (out_band_ - 1) * strides_[0] + kernel_[0]));
        }
        middle_band.reserve(row_bytes * band_rows_);
        if (staging()) {
            depthwise_band.reserve(static_cast<size_t>(depthwise_w_) * channels_ * out_band_);
        }
    }

    const std::vector<int> kernel_;
    std::vector<int> pads_;
    const std::vector<int> strides_;
    const Part pointwise_;
    const Part depthwise_;
    const Part project_;
    const int middle_exponent_;
    const int depthwise_exponent_;
    const int8_t top_;
    const bool pooled_;
    std::vector<int> no_pads_ = std::vector<int>(2 * kSpatialDims, 0);
    const std::vector<int> ones_ = std::vector<int>(kSpatialDims, 1);
    int channels_ = 0;
    int kept_ = 0;
    int depthwise_h_ = 0;
    int depthwise_w_ = 0;
    int band_rows_ = 0;
    int out_band_ = 0;
    dl::base::ArgsType<int8_t> pointwise_once_ = {};
    dl::base::ArgsType<int8_t> depthwise_once_ = {};
    dl::base::ArgsType<int8_t> project_once_ = {};
    RowRun pointwise_run_ = {};
    RowRun project_run_ = {};
    std::array<int32_t, 4> pool_run_ = {};
    int8_t *pointwise_filter_ = nullptr;
    int8_t *depthwise_filter_ = nullptr;
    std::optional<dl::TensorBase> pointwise_bias_;
    std::optional<dl::TensorBase> depthwise_bias_;
    bool built_ = false;
};

}  // namespace

dl::module::Module *pointwise_depthwise_from(fbs::FbsModel *fbs_model, std::string node_name)
{
    return PointwiseDepthwise::deserialize(fbs_model, std::move(node_name));
}

}  // namespace ai
