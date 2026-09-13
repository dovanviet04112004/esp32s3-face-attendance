#include "backends.hpp"

#include <string.h>

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

bool AiLiveness::available() const noexcept
{
    return ai_engine_spoof_input_bytes() > 0;
}

esp_err_t AiLiveness::score(const ai_engine_frame_t &frame, const float box[4], float *live) noexcept
{
    return ai_engine_spoof_face(&frame, box, live);
}

esp_err_t AiEmbedder::embed(const ai_engine_frame_t &frame, const float landmarks[10], int8_t *out,
                            size_t cap_bytes, float *scale) noexcept
{
    return ai_engine_recognize_face(&frame, landmarks, out, cap_bytes, scale);
}

esp_err_t FacedbMatcher::best(const int8_t *emb, float scale, uint32_t *employee_id, float *score,
                              char *name, size_t name_cap) noexcept
{
    svc_facedb_match_t match;
    const esp_err_t err = svc_facedb_lookup(emb, scale, &match);
    if (err != ESP_OK) {
        return err;
    }
    *employee_id = match.employee_id;
    *score = match.score;
    strlcpy(name, match.name, name_cap);
    return ESP_OK;
}

esp_err_t FacedbMatcher::keep(const int8_t *emb, float scale, uint32_t employee_id,
                              const char *name) noexcept
{
    const esp_err_t added = svc_facedb_enroll(employee_id, 0, 255, emb, scale, name);
    return added == ESP_OK ? svc_facedb_persist() : added;
}

}  // namespace vision
