/** The four adapters that put ai_engine and svc_facedb behind the seams of vision.hpp.
 *  @ctx ai_task | init once at boot, the crop buffers live in PSRAM for good
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
    esp_err_t init() noexcept;
    bool available() const noexcept override;
    esp_err_t capture(const ai_engine_frame_t &frame, const float box[4], float *wide_scale) noexcept override;
    esp_err_t score(float *live) noexcept override;

private:
    int8_t *tight_ = nullptr;
    int8_t *wide_ = nullptr;
    size_t bytes_ = 0;
};

class AiEmbedder final : public IEmbedder {
public:
    esp_err_t init() noexcept;
    esp_err_t capture(const ai_engine_frame_t &frame, const float landmarks[10]) noexcept override;
    esp_err_t embed(int8_t *out, size_t cap_bytes, float *scale) noexcept override;

private:
    int8_t *face_ = nullptr;
    size_t bytes_ = 0;
};

class FacedbMatcher final : public IMatcher {
public:
    esp_err_t best(const int8_t *emb, float scale, uint32_t *employee_id, float *score) noexcept override;
};

}  // namespace vision
