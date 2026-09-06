#include "ai_engine.h"

#include <string.h>

#include "antispoof/spoof_model.hpp"
#include "arena.hpp"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "model_store.hpp"
#include "sdkconfig.h"

namespace {

const char *TAG = "ai_engine";

constexpr size_t kFastBytes = CONFIG_AI_ARENA_FAST_KB * 1024U;
constexpr size_t kBigBytes = CONFIG_AI_ARENA_BIG_KB * 1024U;

ai::Arena s_fast;
ai::Arena s_big;
ai::ModelStore s_store;
ai::SpoofModel s_spoof;
size_t s_spoof_crop_len;
bool s_ready;

esp_err_t load_spoof()
{
    const tflite::Model *graph = s_store.find("spoof");
    if (graph == nullptr) {
        return ESP_ERR_NOT_FOUND;
    }
    const esp_err_t err = s_spoof.init(graph, s_fast);
    if (err != ESP_OK) {
        return err;
    }
    const TfLiteTensor *crop = s_spoof.input(0);
    s_spoof_crop_len = crop != nullptr ? crop->bytes : 0;
    return s_spoof_crop_len > 0 ? ESP_OK : ESP_ERR_INVALID_SIZE;
}

}  // namespace

extern "C" esp_err_t ai_engine_init(void)
{
    if (s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    const esp_err_t opened = s_store.open();
    if (opened != ESP_OK) {
        ESP_LOGE(TAG, "models partition: %s", esp_err_to_name(opened));
        return opened;
    }
    const size_t internal_before = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    esp_err_t err = s_fast.reserve(kFastBytes, MALLOC_CAP_INTERNAL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "arena_fast %u KB: %s", CONFIG_AI_ARENA_FAST_KB, esp_err_to_name(err));
        return err;
    }
    err = s_big.reserve(kBigBytes, MALLOC_CAP_SPIRAM);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "arena_big %u KB: %s", CONFIG_AI_ARENA_BIG_KB, esp_err_to_name(err));
        return err;
    }
    ESP_LOGI(TAG, "arena_fast %u KB in %s, arena_big %u KB, internal ram %u to %u KB",
             CONFIG_AI_ARENA_FAST_KB, s_fast.internal() ? "sram" : "psram", CONFIG_AI_ARENA_BIG_KB,
             static_cast<unsigned>(internal_before / 1024),
             static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024));
    err = load_spoof();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "spoof branch: %s", esp_err_to_name(err));
        return err;
    }
    s_ready = true;
    return ESP_OK;
}

extern "C" size_t ai_engine_spoof_crop_len(void)
{
    return s_spoof_crop_len;
}

extern "C" esp_err_t ai_engine_spoof(const int8_t *tight, const int8_t *wide, float *live)
{
    if (!s_ready || tight == nullptr || wide == nullptr || live == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    // Input 0 is the tight crop and input 1 the wide one, the order the packed
    // graph lists them in; swapping them still runs and still scores.
    TfLiteTensor *inputs[] = {s_spoof.input(0), s_spoof.input(1)};
    const int8_t *crops[] = {tight, wide};
    for (int i = 0; i < 2; ++i) {
        if (inputs[i] == nullptr || inputs[i]->bytes != s_spoof_crop_len) {
            return ESP_ERR_INVALID_SIZE;
        }
        memcpy(inputs[i]->data.int8, crops[i], s_spoof_crop_len);
    }
    const esp_err_t err = s_spoof.invoke();
    if (err != ESP_OK) {
        return err;
    }
    *live = s_spoof.score();
    return *live >= 0.0F ? ESP_OK : ESP_FAIL;
}

extern "C" void ai_engine_arena_stats(ai_engine_arena_stats_t *out)
{
    if (out == nullptr) {
        return;
    }
    out->fast_bytes = s_fast.size();
    out->fast_used = s_fast.used();
    out->big_bytes = s_big.size();
    out->big_used = s_big.used();
    out->fast_internal = s_fast.internal();
}
