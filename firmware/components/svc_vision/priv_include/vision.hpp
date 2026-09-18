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
    virtual esp_err_t score(const ai_engine_frame_t &frame, const float box[4],
                            float *live) noexcept = 0;
};

class IEmbedder {
public:
    virtual ~IEmbedder() = default;
    virtual esp_err_t embed(const ai_engine_frame_t &frame, const float landmarks[10], int8_t *out, size_t cap_bytes,
                            float *scale) noexcept = 0;
};

class IMatcher {
public:
    virtual ~IMatcher() = default;
    virtual esp_err_t best(const int8_t *emb, float scale, uint32_t *employee_id, float *score,
                           char *name, size_t name_cap) noexcept = 0;
    virtual esp_err_t keep(const int8_t *emb, float scale, uint32_t employee_id,
                           uint16_t template_idx, const char *name) noexcept = 0;
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
    void observe(svc_vision_seen_cb_t cb, void *ctx) noexcept { seen_cb_ = cb; seen_ctx_ = ctx; }
    void enrol_next(uint32_t employee_id, uint16_t template_idx, const char *name, float yaw_min,
                    float yaw_max) noexcept;
    bool enrol_pending() const noexcept { return enrol_id_ != 0; }
    void reset() noexcept;

private:
    enum class Seen : uint8_t { Nothing, Small, Edge, Face };

    const ai_engine_face_t &pick(size_t count) const noexcept;
    void follow(const ai_engine_face_t &primary) noexcept;
    bool may_verify() const noexcept;
    void verify(const ai_engine_frame_t &frame, const ai_engine_face_t &primary, svc_vision_result_t &out) noexcept;
    void tell(const svc_vision_result_t &out, size_t count) noexcept;

    IDetector &detector_;
    ILiveness &liveness_;
    IEmbedder &embedder_;
    IMatcher &matcher_;
    svc_vision_thresholds_t thresholds_{};
    ai_engine_face_t faces_[kMaxFaces]{};
    int misses_ = 0;
    uint32_t track_ = 0;                  // bumped whenever follow() opens a new one
    uint32_t enrol_id_ = 0;
    uint16_t enrol_idx_ = 0;
    char enrol_name_[STORAGE_NAME_CAP] = {};
    float enrol_yaw_min_ = 0.0f;
    float enrol_yaw_max_ = 0.0f;
    int enrol_spoofs_ = 0;
    svc_vision_seen_cb_t seen_cb_ = nullptr;
    void *seen_ctx_ = nullptr;
    float tracked_[4]{};
    int stable_ = 0;
    int since_verdict_ = -1;
    bool matched_ = false;
    Seen seen_ = Seen::Nothing;
    int8_t embedding_[SVC_FACEDB_EMBED_BYTES]{};
};

}  // namespace vision
