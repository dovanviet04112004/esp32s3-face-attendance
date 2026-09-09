#include "ai_engine.h"

#include <string.h>

#include "antispoof/spoof_model.hpp"
#include "detection/detect_model.hpp"
#include "arena.hpp"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "model_store.hpp"
#include "recognition/recog_model.hpp"
#include "sdkconfig.h"

namespace {

const char *TAG = "ai_engine";

constexpr size_t kFastBytes = CONFIG_AI_ARENA_FAST_KB * 1024U;
constexpr size_t kBigBytes = CONFIG_AI_ARENA_BIG_KB * 1024U;
#ifdef CONFIG_AI_ARENA_FAST_INTERNAL
constexpr uint32_t kFastCaps = MALLOC_CAP_INTERNAL;
#else
constexpr uint32_t kFastCaps = MALLOC_CAP_SPIRAM;
#endif

ai::Arena s_fast;
ai::Arena s_big;
ai::ModelStore s_store;
ai::DetectModel s_detect;
ai::SpoofModel s_spoof;
ai::RecogModel s_recog;
size_t s_detect_len;
size_t s_spoof_len;
size_t s_recog_len;
bool s_ready;

esp_err_t load(ai::ITfliteModel &model, const char *name, ai::Arena &arena, size_t *input_len)
{
    const tflite::Model *graph = s_store.find(name);
    if (graph == nullptr) {
        return ESP_ERR_NOT_FOUND;
    }
    const esp_err_t err = model.init(graph, arena);
    if (err != ESP_OK) {
        return err;
    }
    const TfLiteTensor *first = model.input(0);
    *input_len = first != nullptr ? first->bytes : 0;
    return *input_len > 0 ? ESP_OK : ESP_ERR_INVALID_SIZE;
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
    esp_err_t err = s_fast.reserve(kFastBytes, kFastCaps);
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
    // Detect alone runs every frame, so internal ram goes to it and the other
    // two share one psram allocator (KEHOACH 3.8).
    struct {
        ai::ITfliteModel &model;
        const char *name;
        ai::Arena &arena;
        size_t *input_len;
        bool required;
    } branches[] = {
        {s_detect, "detect", s_fast, &s_detect_len, true},
        {s_spoof, "spoof", s_big, &s_spoof_len, false},
        {s_recog, "recog", s_big, &s_recog_len, false},
    };
    for (auto &branch : branches) {
        err = load(branch.model, branch.name, branch.arena, branch.input_len);
        if (err == ESP_OK) {
            continue;
        }
        // An image carrying fewer than three branches is valid (KEHOACH 6.2.2),
        // and detect is the one the pipeline cannot start without.
        if (branch.required || err != ESP_ERR_NOT_FOUND) {
            ESP_LOGE(TAG, "%s branch: %s", branch.name, esp_err_to_name(err));
            return err;
        }
        ESP_LOGW(TAG, "%s branch absent, its entry points will refuse", branch.name);
        *branch.input_len = 0;
    }
    s_ready = true;
    return ESP_OK;
}

extern "C" size_t ai_engine_detect_input_len(void)
{
    return s_detect_len;
}

extern "C" size_t ai_engine_spoof_input_len(void)
{
    return s_spoof_len;
}

extern "C" size_t ai_engine_recog_input_len(void)
{
    return s_recog_len;
}

extern "C" esp_err_t ai_engine_detect(const int8_t *image)
{
    if (!s_ready || image == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    TfLiteTensor *frame = s_detect.input(0);
    if (frame == nullptr || frame->bytes != s_detect_len) {
        return ESP_ERR_INVALID_SIZE;
    }
    memcpy(frame->data.int8, image, s_detect_len);
    return s_detect.invoke();
}

extern "C" esp_err_t ai_engine_recognize(const int8_t *face, int8_t *out, size_t cap, float *scale)
{
    // A zero length means the image carried no such branch (KEHOACH 6.2.2).
    if (!s_ready || s_recog_len == 0 || face == nullptr || out == nullptr || scale == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    TfLiteTensor *crop = s_recog.input(0);
    if (crop == nullptr || crop->bytes != s_recog_len) {
        return ESP_ERR_INVALID_SIZE;
    }
    memcpy(crop->data.int8, face, s_recog_len);
    const esp_err_t err = s_recog.invoke();
    if (err != ESP_OK) {
        return err;
    }
    return s_recog.embedding(out, cap, scale) > 0 ? ESP_OK : ESP_ERR_INVALID_SIZE;
}

extern "C" esp_err_t ai_engine_spoof(const int8_t *tight, const int8_t *wide, float *live)
{
    // A zero length means the image carried no such branch (KEHOACH 6.2.2).
    if (!s_ready || s_spoof_len == 0 || tight == nullptr || wide == nullptr || live == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    // Input 0 is the tight crop and input 1 the wide one, the order the packed
    // graph lists them in; swapping them still runs and still scores.
    TfLiteTensor *inputs[] = {s_spoof.input(0), s_spoof.input(1)};
    const int8_t *crops[] = {tight, wide};
    for (int i = 0; i < 2; ++i) {
        if (inputs[i] == nullptr || inputs[i]->bytes != s_spoof_len) {
            return ESP_ERR_INVALID_SIZE;
        }
        memcpy(inputs[i]->data.int8, crops[i], s_spoof_len);
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
    out->fast_used_bytes = s_fast.used();
    out->big_bytes = s_big.size();
    out->big_used_bytes = s_big.used();
    out->fast_internal = s_fast.internal();
}
