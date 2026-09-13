/** The four adapters that put ai_engine and svc_facedb behind the seams of vision.hpp.
 *  @ctx ai_task | stateless: every call works on the frame it is handed
 */
#pragma once

#include "vision.hpp"

namespace vision {

class AiDetector final : public IDetector {
public:
    size_t detect(const ai_engine_frame_t &frame, float min_score, ai_engine_face_t *out, size_t cap) noexcept override;
};

class AiLiveness final : public ILiveness {
public:
    bool available() const noexcept override;
    esp_err_t score(const ai_engine_frame_t &frame, const float box[4], float *live) noexcept override;
};

class AiEmbedder final : public IEmbedder {
public:
    esp_err_t embed(const ai_engine_frame_t &frame, const float landmarks[10], int8_t *out, size_t cap_bytes,
                    float *scale) noexcept override;
};

class FacedbMatcher final : public IMatcher {
public:
    esp_err_t best(const int8_t *emb, float scale, uint32_t *employee_id, float *score,
                   char *name, size_t name_cap) noexcept override;
    esp_err_t keep(const int8_t *emb, float scale, uint32_t employee_id,
                   const char *name) noexcept override;
};

}  // namespace vision
