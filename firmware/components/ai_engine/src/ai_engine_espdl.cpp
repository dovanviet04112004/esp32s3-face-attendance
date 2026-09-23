#include "ai_engine.h"

#include <string.h>

#include "antispoof/spoof_model.hpp"
#include "detection/detect_model.hpp"
#include "esp_log.h"
#include "espdl_model.hpp"
#include "recognition/recog_model.hpp"
#include "sdkconfig.h"
#include "sys_storage.h"

namespace {

const char *TAG = "ai_engine";

#ifdef CONFIG_AI_WEIGHTS_PSRAM_DETECT
constexpr bool kDetectWeightsPsram = true;
#else
constexpr bool kDetectWeightsPsram = false;
#endif
#ifdef CONFIG_AI_WEIGHTS_PSRAM_SPOOF
constexpr bool kSpoofWeightsPsram = true;
#else
constexpr bool kSpoofWeightsPsram = false;
#endif
#ifdef CONFIG_AI_WEIGHTS_PSRAM_RECOG
constexpr bool kRecogWeightsPsram = true;
#else
constexpr bool kRecogWeightsPsram = false;
#endif

ai::EspdlModel s_detect;
ai::EspdlModel s_spoof;
ai::EspdlModel s_recog;
size_t s_detect_len;
size_t s_spoof_len;
size_t s_recog_len;
bool s_ready;
bool s_detected;

esp_err_t load(ai::EspdlModel &model, const char *name, bool copy_weights, size_t *input_len)
{
    const void *data = nullptr;
    size_t size = 0;
    const esp_err_t found = sys_storage_model_find(name, &data, &size, nullptr);
    if (found != ESP_OK) {
        return found;
    }
    if (memcmp(data, "EDL2", 4) != 0) {
        ESP_LOGE(TAG, "%s is not an .espdl entry and this build runs ESP-DL", name);
        return ESP_ERR_NOT_SUPPORTED;
    }
    const esp_err_t err = model.init(data, name, copy_weights);
    if (err != ESP_OK) {
        return err;
    }
    const ai::TensorView first = model.input();
    *input_len = first.valid() ? first.bytes : 0;
    return *input_len > 0 ? ESP_OK : ESP_ERR_INVALID_SIZE;
}

esp_err_t run(ai::EspdlModel &model, const int8_t *input, size_t len)
{
    const ai::TensorView tensor = model.input();
    if (!tensor.valid() || tensor.bytes != len) {
        return ESP_ERR_INVALID_SIZE;
    }
    memcpy(tensor.data, input, len);
    return model.invoke();
}

esp_err_t embed(int8_t *out, size_t cap_bytes, float *scale)
{
    return ai::normalized_int8(s_recog.output(0), out, cap_bytes, scale) > 0 ? ESP_OK : ESP_ERR_INVALID_SIZE;
}

esp_err_t live(float *score)
{
    *score = ai::live_score(s_spoof.output(0));
    return *score >= 0.0F ? ESP_OK : ESP_FAIL;
}

}  // namespace

extern "C" esp_err_t ai_engine_init(void)
{
    if (s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    const storage_models_header_t *header = nullptr;
    const esp_err_t opened = sys_storage_models_open(&header);
    if (opened != ESP_OK) {
        ESP_LOGE(TAG, "models partition: %s", esp_err_to_name(opened));
        return opened;
    }
    struct {
        ai::EspdlModel &model;
        const char *name;
        bool copy_weights;
        size_t *input_len;
        bool required;
    } branches[] = {
        {s_detect, "detect", kDetectWeightsPsram, &s_detect_len, true},
        {s_spoof, "spoof", kSpoofWeightsPsram, &s_spoof_len, false},
        {s_recog, "recog", kRecogWeightsPsram, &s_recog_len, false},
    };
    for (auto &branch : branches) {
        const esp_err_t err = load(branch.model, branch.name, branch.copy_weights, branch.input_len);
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

extern "C" void ai_engine_arena_stats(ai_engine_arena_stats_t *out)
{
    if (out != nullptr) {
        memset(out, 0, sizeof(*out));
    }
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

extern "C" size_t ai_engine_recog_output_bytes(void)
{
    const ai::TensorView tensor = s_ready ? s_recog.output(0) : ai::TensorView();
    return tensor.valid() ? tensor.bytes : 0;
}

extern "C" esp_err_t ai_engine_detect(const int8_t *image)
{
    if (!s_ready || image == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    const esp_err_t err = run(s_detect, image, s_detect_len);
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
        heads[i] = s_detect.output(i);
    }
    return ai::decode_faces(s_detect.input(), heads, count, min_score, out, cap);
}

extern "C" esp_err_t ai_engine_detect_frame(const ai_engine_frame_t *frame, ai_engine_letterbox_t *geometry)
{
    if (!s_ready || frame == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    ai_engine_letterbox_t local;
    const esp_err_t boxed = ai::letterbox_frame(*frame, s_detect.input(), geometry != nullptr ? geometry : &local);
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
    const ai::TensorView crop = s_recog.input();
    const esp_err_t aligned = ai::align_face(*frame, landmarks, crop, crop.data, crop.bytes);
    if (aligned != ESP_OK) {
        return aligned;
    }
    const esp_err_t err = s_recog.invoke();
    return err != ESP_OK ? err : embed(out, cap_bytes, scale);
}

extern "C" esp_err_t ai_engine_spoof_face(const ai_engine_frame_t *frame, const float box[4], float *score)
{
    if (!s_ready || s_spoof_len == 0 || frame == nullptr || box == nullptr || score == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    const ai::TensorView input = s_spoof.input();
    const esp_err_t cut = ai::crop_face(*frame, box, input, input.data, s_spoof_len);
    if (cut != ESP_OK) {
        return cut;
    }
    const esp_err_t err = s_spoof.invoke();
    return err != ESP_OK ? err : live(score);
}

extern "C" esp_err_t ai_engine_recognize(const int8_t *face, int8_t *out, size_t cap_bytes, float *scale)
{
    // A zero length means the image carried no such branch (KEHOACH 6.2.2).
    if (!s_ready || s_recog_len == 0 || face == nullptr || out == nullptr || scale == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    const esp_err_t err = run(s_recog, face, s_recog_len);
    return err != ESP_OK ? err : embed(out, cap_bytes, scale);
}

extern "C" esp_err_t ai_engine_spoof(const int8_t *face, float *score)
{
    // A zero length means the image carried no such branch (KEHOACH 6.2.2).
    if (!s_ready || s_spoof_len == 0 || face == nullptr || score == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    const esp_err_t err = run(s_spoof, face, s_spoof_len);
    return err != ESP_OK ? err : live(score);
}
