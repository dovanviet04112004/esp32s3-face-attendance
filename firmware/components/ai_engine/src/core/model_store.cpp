#include "model_store.hpp"

#include "esp_log.h"
#include "sys_storage.h"
#include "tensorflow/lite/micro/micro_interpreter.h"

namespace ai {

namespace {

const char *TAG = "ai_store";

}  // namespace

esp_err_t ModelStore::open() noexcept
{
    const esp_err_t err = sys_storage_models_open(&header_);
    if (err != ESP_OK) {
        header_ = nullptr;
        return err;
    }
    ESP_LOGI(TAG, "%u model(s) in the active slot", static_cast<unsigned>(header_->count));
    return ESP_OK;
}

uint32_t ModelStore::arena_hint_bytes(const char *name) const noexcept
{
    const void *data = nullptr;
    size_t size = 0;
    uint32_t hint = 0;
    if (sys_storage_model_find(name, &data, &size, &hint) != ESP_OK) {
        return 0;
    }
    return hint;
}

const tflite::Model *ModelStore::find(const char *name) const noexcept
{
    const void *data = nullptr;
    size_t size = 0;
    if (sys_storage_model_find(name, &data, &size, nullptr) != ESP_OK) {
        ESP_LOGE(TAG, "no model named %s", name);
        return nullptr;
    }
    const tflite::Model *model = tflite::GetModel(data);
    if (model->version() != TFLITE_SCHEMA_VERSION) {
        // A schema mismatch misreads tensors rather than failing outright.
        ESP_LOGE(TAG, "%s is schema %u, this build reads %u", name,
                 static_cast<unsigned>(model->version()), TFLITE_SCHEMA_VERSION);
        return nullptr;
    }
    ESP_LOGI(TAG, "%s: %u KB", name, static_cast<unsigned>(size / 1024));
    return model;
}

}  // namespace ai
