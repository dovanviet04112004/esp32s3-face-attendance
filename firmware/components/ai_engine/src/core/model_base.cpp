#include "tflite_model.hpp"

#include <new>

#include "esp_log.h"

namespace ai {

namespace {

const char *TAG = "ai_model";

}  // namespace

TfliteModelBase::~TfliteModelBase()
{
    if (interpreter_ != nullptr) {
        interpreter_->~MicroInterpreter();
    }
}

esp_err_t TfliteModelBase::init(const tflite::Model *model, Arena &arena) noexcept
{
    if (model == nullptr || arena.allocator() == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    if (interpreter_ != nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    // Passing the arena's allocator rather than its buffer is what lets the
    // models on one arena share a head and stack their tails (KEHOACH 3.10).
    interpreter_ = new (storage_)
        tflite::MicroInterpreter(model, resolver(), arena.allocator(), nullptr, profiler());
    if (interpreter_->AllocateTensors() != kTfLiteOk) {
        // A half-allocated interpreter holds node pointers it never filled, so
        // running its destructor here reads them and faults.
        ESP_LOGE(TAG, "%s: allocate failed on an arena of %u KB", name(),
                 static_cast<unsigned>(arena.size() / 1024));
        interpreter_ = nullptr;
        return ESP_ERR_NO_MEM;
    }
    ESP_LOGI(TAG, "%s: %u in, %u out, arena at %u of %u KB", name(),
             static_cast<unsigned>(interpreter_->inputs_size()),
             static_cast<unsigned>(interpreter_->outputs_size()),
             static_cast<unsigned>(arena.used() / 1024),
             static_cast<unsigned>(arena.size() / 1024));
    return ESP_OK;
}

TfLiteTensor *TfliteModelBase::input(int index) noexcept
{
    return interpreter_ != nullptr ? interpreter_->input(static_cast<size_t>(index)) : nullptr;
}

TfLiteTensor *TfliteModelBase::output(int index) noexcept
{
    return interpreter_ != nullptr ? interpreter_->output(static_cast<size_t>(index)) : nullptr;
}

esp_err_t TfliteModelBase::invoke() noexcept
{
    if (interpreter_ == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    const TfLiteStatus status = interpreter_->Invoke();
    profiler_report(name());
    return status == kTfLiteOk ? ESP_OK : ESP_FAIL;
}

size_t TfliteModelBase::arena_used() const noexcept
{
    return interpreter_ != nullptr ? interpreter_->arena_used_bytes() : 0;
}

}  // namespace ai
