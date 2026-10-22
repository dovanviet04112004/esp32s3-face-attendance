#include "core/espdl/espdl_model.hpp"

#include <iterator>
#include <new>

#include "core/espdl/espdl_channel_conv.hpp"
#include "core/espdl/espdl_conv_im2col.hpp"
#include "core/espdl/espdl_conv_prelu.hpp"
#include "core/espdl/espdl_conv_slices.hpp"
#include "core/espdl/espdl_mul_add.hpp"
#include "core/espdl/espdl_pointwise_depthwise.hpp"
#include "core/espdl/espdl_spatial_mean.hpp"
#include "dl_model_base.hpp"
#include "dl_module_creator.hpp"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "sdkconfig.h"

namespace ai {

namespace {

const char *TAG = "espdl_model";

// Small mallocs go internal first below SPIRAM_MALLOC_ALWAYSINTERNAL; a graph
// is thousands of them and would take the RAM DMA and Wi-Fi need (KEHOACH 6.4).
class ExternalMallocGuard {
public:
    ExternalMallocGuard() noexcept { heap_caps_malloc_extmem_enable(0); }
    ~ExternalMallocGuard() { heap_caps_malloc_extmem_enable(CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL); }
    ExternalMallocGuard(const ExternalMallocGuard &) = delete;
    ExternalMallocGuard &operator=(const ExternalMallocGuard &) = delete;
};

int s_plan_failures = 0;

}  // namespace

void mark_plan_failed(const char *module) noexcept
{
    ESP_LOGE(TAG, "%s: no memory for its buffer", module);
    ++s_plan_failures;
}

void register_espdl_modules() noexcept
{
    dl::module::ModuleCreator *creator = dl::module::ModuleCreator::get_instance();
    // esp-dl fills its own table only while the table is empty, so it goes first.
    creator->register_dl_modules();
    creator->register_module("ConvPRelu", conv_prelu_from);
    creator->register_module("ConvSlices", conv_slices_from);
    creator->register_module("ChannelConv", channel_conv_from);
    creator->register_module("ConvIm2col", conv_im2col_from);
    creator->register_module("MulAdd", mul_add_from);
    creator->register_module("PointwiseDepthwise", pointwise_depthwise_from);
    creator->register_module("SpatialMean", spatial_mean_from);
}

TensorView view_of(dl::TensorBase *tensor) noexcept
{
    TensorView view;
    if (tensor == nullptr || tensor->get_dtype() != dl::DATA_TYPE_INT8 || tensor->shape.size() > kMaxRank) {
        return view;
    }
    view.data = tensor->get_element_ptr<int8_t>();
    view.rank = static_cast<int>(tensor->shape.size());
    for (int i = 0; i < view.rank; ++i) {
        view.dims[i] = tensor->shape[i];
    }
    view.bytes = static_cast<size_t>(tensor->size);
    view.scale = DL_SCALE(tensor->get_exponent());
    view.zero_point = 0;
    return view;
}

esp_err_t EspdlModel::init(const void *blob, const char *name, bool copy_weights) noexcept
{
    if (blob == nullptr || name == nullptr || model_ != nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    name_ = name;
    const size_t internal_before = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    const size_t psram_before = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    const int64_t started_us = esp_timer_get_time();
    dl::Model *model = nullptr;
    s_plan_failures = 0;
    {
        const ExternalMallocGuard guard;
        register_espdl_modules();
        // max_internal_size 0 keeps every tensor in PSRAM (KEHOACH 3 layer 5).
        model = new (std::nothrow) dl::Model(static_cast<const char *>(blob), fbs::MODEL_LOCATION_IN_FLASH_RODATA,
                                             0, dl::MEMORY_MANAGER_GREEDY, nullptr, copy_weights);
    }
    if (model == nullptr) {
        return ESP_ERR_NO_MEM;
    }
    if (s_plan_failures > 0) {
        ESP_LOGE(TAG, "%s: %d modules have no buffer to run in", name_, s_plan_failures);
        delete model;
        return ESP_ERR_NO_MEM;
    }
    // The constructor reports nothing; a graph it could not finish has no outputs.
    if (model->get_inputs().empty() || model->get_outputs().empty()) {
        ESP_LOGE(TAG, "%s: ESP-DL stopped building the graph, see its log above", name_);
        delete model;
        return ESP_ERR_NOT_SUPPORTED;
    }
    model_ = model;
    ESP_LOGI(TAG, "%s: built in %lld us, weights %s, internal %u B, psram %u B", name_,
             static_cast<long long>(esp_timer_get_time() - started_us), copy_weights ? "in psram" : "in flash",
             static_cast<unsigned>(internal_before - heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
             static_cast<unsigned>(psram_before - heap_caps_get_free_size(MALLOC_CAP_SPIRAM)));
    return ESP_OK;
}

TensorView EspdlModel::input() noexcept
{
    if (model_ == nullptr) {
        return TensorView();
    }
    return view_of(model_->get_inputs().begin()->second);
}

size_t EspdlModel::output_count() noexcept
{
    return model_ != nullptr ? model_->get_outputs().size() : 0;
}

TensorView EspdlModel::output(size_t index) noexcept
{
    if (model_ == nullptr || index >= model_->get_outputs().size()) {
        return TensorView();
    }
    auto at = model_->get_outputs().begin();
    std::advance(at, index);
    return view_of(at->second);
}

esp_err_t EspdlModel::invoke() noexcept
{
    if (model_ == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
#ifdef CONFIG_AI_PROFILING
    // profile_module forwards every module itself, timing each, so it replaces run().
    model_->profile_module(true);
#else
    model_->run();
#endif
    return ESP_OK;
}

}  // namespace ai
