#include "ai_engine.h"

#include <algorithm>
#include <initializer_list>
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
constexpr size_t kArenaRoundBytes = 1024U;
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
bool s_detected;

size_t arena_bytes(const char *arena_name, size_t ceiling, std::initializer_list<const char *> group)
{
    size_t wanted = 0;
    for (const char *branch : group) {
        wanted = std::max<size_t>(wanted, s_store.arena_hint_bytes(branch));
    }
    if (wanted == 0) {
        return ceiling;
    }
    // arena_used_bytes() is a lower bound: TFLM's alignment padding depends on
    // the arena's own base and size, so detect refuses at exactly its own used.
    wanted = (wanted + kArenaRoundBytes - 1) / kArenaRoundBytes * kArenaRoundBytes;
    if (wanted > ceiling) {
        // Allocating the ceiling instead would only move the failure into
        // AllocateTensors, where the message names an operator, not the cause.
        ESP_LOGE(TAG, "%s: image asks %u B, %s caps it at %u B", arena_name,
                 static_cast<unsigned>(wanted), arena_name, static_cast<unsigned>(ceiling));
        return 0;
    }
    return wanted;
}

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
    const size_t fast_bytes = arena_bytes("arena_fast", kFastBytes, {"detect"});
    const size_t big_bytes = arena_bytes("arena_big", kBigBytes, {"spoof", "recog"});
    if (fast_bytes == 0 || big_bytes == 0) {
        return ESP_ERR_INVALID_SIZE;
    }
    const size_t internal_before = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    esp_err_t err = s_fast.reserve(fast_bytes, kFastCaps);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "arena_fast %u B: %s", static_cast<unsigned>(fast_bytes),
                 esp_err_to_name(err));
        return err;
    }
    err = s_big.reserve(big_bytes, MALLOC_CAP_SPIRAM);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "arena_big %u B: %s", static_cast<unsigned>(big_bytes), esp_err_to_name(err));
        return err;
    }
    ESP_LOGI(TAG, "arena_fast %u B in %s, arena_big %u B, internal ram %u to %u KB",
             static_cast<unsigned>(fast_bytes), s_fast.internal() ? "sram" : "psram",
             static_cast<unsigned>(big_bytes), static_cast<unsigned>(internal_before / 1024),
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

extern "C" size_t ai_engine_detect_input_bytes(void)
{
    return s_detect_len;
}

extern "C" size_t ai_engine_spoof_input_bytes(void)
{
    return s_spoof_len;
}

extern "C" size_t ai_engine_recog_input_bytes(void)
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
    const esp_err_t err = s_detect.invoke();
    s_detected = err == ESP_OK;
    return err;
}

extern "C" size_t ai_engine_faces(float min_score, ai_engine_face_t *out, size_t cap)
{
    if (!s_ready || !s_detected || out == nullptr) {
        return 0;
    }
    ai::TensorView heads[ai::kDetectHeads];
    const size_t count = s_detect.output_count();
    if (count > ai::kDetectHeads) {
        return 0;
    }
    for (size_t i = 0; i < count; ++i) {
        heads[i] = ai::view_of(s_detect.output(static_cast<int>(i)));
    }
    return ai::decode_faces(ai::view_of(s_detect.input(0)), heads, count, min_score, out, cap);
}

extern "C" esp_err_t ai_engine_detect_frame(const ai_engine_frame_t *frame, ai_engine_letterbox_t *geometry)
{
    if (!s_ready || frame == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    ai_engine_letterbox_t local;
    const esp_err_t boxed =
        ai::letterbox_frame(*frame, ai::view_of(s_detect.input(0)), geometry != nullptr ? geometry : &local);
    if (boxed != ESP_OK) {
        return boxed;
    }
    const esp_err_t err = s_detect.invoke();
    s_detected = err == ESP_OK;
    return err;
}

extern "C" esp_err_t ai_engine_recognize_face(const ai_engine_frame_t *frame, const float landmarks[10], int8_t *out,
                                              size_t cap_bytes, float *scale)
{
    if (!s_ready || s_recog_len == 0 || frame == nullptr || landmarks == nullptr || out == nullptr || scale == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    const ai::TensorView crop = ai::view_of(s_recog.input(0));
    const esp_err_t aligned = ai::align_face(*frame, landmarks, crop, crop.data, crop.bytes);
    if (aligned != ESP_OK) {
        return aligned;
    }
    const esp_err_t err = s_recog.invoke();
    if (err != ESP_OK) {
        return err;
    }
    return s_recog.embedding(out, cap_bytes, scale) > 0 ? ESP_OK : ESP_ERR_INVALID_SIZE;
}

extern "C" esp_err_t ai_engine_spoof_face(const ai_engine_frame_t *frame, const float box[4], float *live)
{
    if (!s_ready || s_spoof_len == 0 || frame == nullptr || box == nullptr || live == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    const ai::TensorView input = ai::view_of(s_spoof.input(0));
    const esp_err_t cut = ai::crop_face(*frame, box, input, input.data, s_spoof_len);
    if (cut != ESP_OK) {
        return cut;
    }
    const esp_err_t err = s_spoof.invoke();
    if (err != ESP_OK) {
        return err;
    }
    *live = s_spoof.score();
    return *live >= 0.0F ? ESP_OK : ESP_FAIL;
}

extern "C" size_t ai_engine_recog_output_bytes(void)
{
    const TfLiteTensor *tensor = s_ready ? s_recog.output(0) : nullptr;
    return tensor != nullptr ? tensor->bytes : 0;
}

extern "C" esp_err_t ai_engine_recognize(const int8_t *face, int8_t *out, size_t cap_bytes,
                                         float *scale)
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
    return s_recog.embedding(out, cap_bytes, scale) > 0 ? ESP_OK : ESP_ERR_INVALID_SIZE;
}

extern "C" esp_err_t ai_engine_spoof(const int8_t *face, float *live)
{
    // A zero length means the image carried no such branch (KEHOACH 6.2.2).
    if (!s_ready || s_spoof_len == 0 || face == nullptr || live == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    TfLiteTensor *input = s_spoof.input(0);
    if (input == nullptr || input->bytes != s_spoof_len) {
        return ESP_ERR_INVALID_SIZE;
    }
    memcpy(input->data.int8, face, s_spoof_len);
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
