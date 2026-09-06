#include "ai_engine.h"

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
bool s_ready;

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
    s_ready = true;
    return ESP_OK;
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
