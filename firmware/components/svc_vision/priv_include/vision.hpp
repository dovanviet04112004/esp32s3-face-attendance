/** The four seams the pipeline is built on, and the pipeline (KEHOACH 4.5.5d).
 *  @ctx ai_task | every method blocks for the model behind it
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "ai_engine.h"
#include "esp_err.h"
#include "svc_facedb.h"
#include "svc_vision.h"

namespace vision {

constexpr size_t kMaxFaces = 8;

class IDetector {
public:
    virtual ~IDetector() = default;
    virtual size_t detect(const ai_engine_frame_t &frame, float min_score, ai_engine_face_t *out,
                          size_t cap) noexcept = 0;
};

class ILiveness {
public:
    virtual ~ILiveness() = default;
    virtual bool available() const noexcept = 0;
    virtual esp_err_t capture(const ai_engine_frame_t &frame, const float box[4], float *wide_scale) noexcept = 0;
    virtual esp_err_t score(float *live) noexcept = 0;
};

class IEmbedder {
public:
    virtual ~IEmbedder() = default;
    virtual esp_err_t capture(const ai_engine_frame_t &frame, const float landmarks[10]) noexcept = 0;
    virtual esp_err_t embed(int8_t *out, size_t cap_bytes, float *scale) noexcept = 0;
};

class IMatcher {
public:
    virtual ~IMatcher() = default;
    virtual esp_err_t best(const int8_t *emb, float scale, uint32_t *employee_id, float *score) noexcept = 0;
};

class VisionPipeline {
public:
    VisionPipeline(IDetector &detector, ILiveness &liveness, IEmbedder &embedder, IMatcher &matcher) noexcept
        : detector_(detector), liveness_(liveness), embedder_(embedder), matcher_(matcher)
    {
    }
    VisionPipeline(const VisionPipeline &) = delete;
    VisionPipeline &operator=(const VisionPipeline &) = delete;

    void configure(const svc_vision_thresholds_t &thresholds) noexcept { thresholds_ = thresholds; }
    svc_vision_result_t step(const ai_engine_frame_t &frame) noexcept;
    void reset() noexcept;

private:
    enum class Stage : uint8_t { Track, Liveness, Embed };
    enum class Seen : uint8_t { Nothing, Small, Face };

    void follow(const ai_engine_face_t &primary) noexcept;
    bool may_verify() const noexcept;
    void verdict(bool matched) noexcept;
    void begin(const ai_engine_frame_t &frame, const ai_engine_face_t &primary) noexcept;
    void liveness(svc_vision_result_t &out) noexcept;
    void embed(svc_vision_result_t &out) noexcept;

    IDetector &detector_;
    ILiveness &liveness_;
    IEmbedder &embedder_;
    IMatcher &matcher_;
    svc_vision_thresholds_t thresholds_{};
    ai_engine_face_t faces_[kMaxFaces]{};
    float tracked_[4]{};
    int stable_ = 0;
    int since_verdict_ = -1;
    bool matched_ = false;
    Stage stage_ = Stage::Track;
    Seen seen_ = Seen::Nothing;
    float pending_wide_ = -1.0f;
    float pending_live_ = -1.0f;
    int8_t embedding_[SVC_FACEDB_EMBED_BYTES]{};
};

}  // namespace vision
