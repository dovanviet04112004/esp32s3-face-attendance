#include "backends.hpp"

#include "esp_heap_caps.h"

namespace vision {

size_t AiDetector::detect(const ai_engine_frame_t &frame, float min_score, ai_engine_face_t *out,
                          size_t cap) noexcept
{
    ai_engine_letterbox_t geometry;
    if (ai_engine_detect_frame(&frame, &geometry) != ESP_OK) {
        return 0;
    }
    const size_t count = ai_engine_faces(min_score, out, cap);
    for (size_t i = 0; i < count; ++i) {
        ai_engine_face_to_frame(&geometry, &out[i]);
    }
    return count;
}

esp_err_t AiLiveness::init() noexcept
{
    bytes_ = ai_engine_spoof_input_bytes();
    if (bytes_ == 0) {
        return ESP_OK;
    }
    tight_ = static_cast<int8_t *>(heap_caps_malloc(bytes_, MALLOC_CAP_SPIRAM));
    wide_ = static_cast<int8_t *>(heap_caps_malloc(bytes_, MALLOC_CAP_SPIRAM));
    return (tight_ != nullptr && wide_ != nullptr) ? ESP_OK : ESP_ERR_NO_MEM;
}

bool AiLiveness::available() const noexcept
{
    return bytes_ > 0 && tight_ != nullptr && wide_ != nullptr;
}

esp_err_t AiLiveness::capture(const ai_engine_frame_t &frame, const float box[4], float *wide_scale) noexcept
{
    if (!available()) {
        return ESP_ERR_INVALID_STATE;
    }
    return ai_engine_spoof_crops(&frame, box, tight_, wide_, bytes_, wide_scale);
}

esp_err_t AiLiveness::score(float *live) noexcept
{
    if (!available()) {
        return ESP_ERR_INVALID_STATE;
    }
    return ai_engine_spoof(tight_, wide_, live);
}

esp_err_t AiEmbedder::init() noexcept
{
    bytes_ = ai_engine_recog_input_bytes();
    if (bytes_ == 0) {
        return ESP_ERR_NOT_FOUND;
    }
    face_ = static_cast<int8_t *>(heap_caps_malloc(bytes_, MALLOC_CAP_SPIRAM));
    return face_ != nullptr ? ESP_OK : ESP_ERR_NO_MEM;
}

esp_err_t AiEmbedder::capture(const ai_engine_frame_t &frame, const float landmarks[10]) noexcept
{
    if (face_ == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    return ai_engine_align_face(&frame, landmarks, face_, bytes_);
}

esp_err_t AiEmbedder::embed(int8_t *out, size_t cap_bytes, float *scale) noexcept
{
    if (face_ == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    return ai_engine_recognize(face_, out, cap_bytes, scale);
}

esp_err_t FacedbMatcher::best(const int8_t *emb, float scale, uint32_t *employee_id, float *score) noexcept
{
    svc_facedb_match_t match;
    const esp_err_t err = svc_facedb_lookup(emb, scale, &match);
    if (err != ESP_OK) {
        return err;
    }
    *employee_id = match.employee_id;
    *score = match.score;
    return ESP_OK;
}

}  // namespace vision
