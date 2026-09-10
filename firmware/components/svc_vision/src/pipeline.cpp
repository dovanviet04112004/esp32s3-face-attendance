#include "vision.hpp"

#include <string.h>

namespace vision {

namespace {

// Recognition runs only once the box has held still this many detects (KEHOACH 3, layer 5).
constexpr int kStableDetects = 2;
constexpr float kSameFaceIou = 0.5f;
// A verdict other than MATCH is retried after this many detects on the same track.
constexpr int kRetryDetects = 6;

float iou(const float *a, const float *b) noexcept
{
    const float left = a[0] > b[0] ? a[0] : b[0];
    const float top = a[1] > b[1] ? a[1] : b[1];
    const float right = a[2] < b[2] ? a[2] : b[2];
    const float bottom = a[3] < b[3] ? a[3] : b[3];
    const float width = right > left ? right - left : 0.0f;
    const float height = bottom > top ? bottom - top : 0.0f;
    const float inter = width * height;
    const float joined = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    return joined > 0.0f ? inter / joined : 0.0f;
}

float side_of(const float *box) noexcept
{
    const float width = box[2] - box[0];
    const float height = box[3] - box[1];
    return width > height ? width : height;
}

const ai_engine_face_t &largest(const ai_engine_face_t *faces, size_t count) noexcept
{
    size_t best = 0;
    for (size_t i = 1; i < count; ++i) {
        if (side_of(faces[i].box) > side_of(faces[best].box)) {
            best = i;
        }
    }
    return faces[best];
}

svc_vision_result_t blank() noexcept
{
    svc_vision_result_t out;
    memset(&out, 0, sizeof(out));
    out.kind = SVC_VISION_NONE;
    out.match_score = -1.0f;
    out.live_score = -1.0f;
    out.wide_scale = -1.0f;
    return out;
}

}  // namespace

void VisionPipeline::reset() noexcept
{
    stable_ = 0;
    since_verdict_ = -1;
    matched_ = false;
    stage_ = Stage::Track;
    seen_ = Seen::Nothing;
}

void VisionPipeline::follow(const ai_engine_face_t &primary) noexcept
{
    if (stable_ > 0 && iou(tracked_, primary.box) >= kSameFaceIou) {
        ++stable_;
        if (since_verdict_ >= 0) {
            ++since_verdict_;
        }
    } else {
        stable_ = 1;
        since_verdict_ = -1;
        matched_ = false;
        stage_ = Stage::Track;
    }
    memcpy(tracked_, primary.box, sizeof(tracked_));
}

bool VisionPipeline::may_verify() const noexcept
{
    return since_verdict_ < 0 || (!matched_ && since_verdict_ >= kRetryDetects);
}

void VisionPipeline::verdict(bool matched) noexcept
{
    matched_ = matched;
    since_verdict_ = 0;
    stage_ = Stage::Track;
}

void VisionPipeline::begin(const ai_engine_frame_t &frame, const ai_engine_face_t &primary) noexcept
{
    // Both crops are taken from this frame now: the frame goes back to the camera
    // after this step, and spoof's run will overwrite recog's input (KEHOACH 3.8).
    pending_wide_ = -1.0f;
    pending_live_ = -1.0f;
    if (liveness_.available() && liveness_.capture(frame, primary.box, &pending_wide_) != ESP_OK) {
        return;
    }
    if (embedder_.capture(frame, primary.landmarks) != ESP_OK) {
        return;
    }
    stage_ = liveness_.available() ? Stage::Liveness : Stage::Embed;
}

void VisionPipeline::liveness(svc_vision_result_t &out) noexcept
{
    float live = -1.0f;
    if (liveness_.score(&live) != ESP_OK) {
        stage_ = Stage::Track;
        return;
    }
    pending_live_ = live;
    if (live < thresholds_.live_min_score) {
        out.kind = SVC_VISION_SPOOF;
        out.live_score = live;
        out.wide_scale = pending_wide_;
        verdict(false);
        return;
    }
    stage_ = Stage::Embed;
}

void VisionPipeline::embed(svc_vision_result_t &out) noexcept
{
    float scale = 0.0f;
    if (embedder_.embed(embedding_, sizeof(embedding_), &scale) != ESP_OK) {
        stage_ = Stage::Track;
        return;
    }
    uint32_t employee_id = 0;
    float score = -1.0f;
    const esp_err_t found = matcher_.best(embedding_, scale, &employee_id, &score);
    out.live_score = pending_live_;
    out.wide_scale = pending_wide_;
    out.match_score = score;
    if (found == ESP_OK && score >= thresholds_.match_min_score) {
        out.kind = SVC_VISION_MATCH;
        out.employee_id = employee_id;
        verdict(true);
        return;
    }
    out.kind = SVC_VISION_UNKNOWN;
    verdict(false);
}

svc_vision_result_t VisionPipeline::step(const ai_engine_frame_t &frame) noexcept
{
    svc_vision_result_t out = blank();
    const size_t count = detector_.detect(frame, thresholds_.detect_min_score, faces_, kMaxFaces);
    out.faces = static_cast<uint8_t>(count);
    for (size_t i = 0; i < count && i < SVC_VISION_REPORTED_FACES; ++i) {
        memcpy(out.boxes[i].box, faces_[i].box, sizeof(out.boxes[i].box));
    }
    if (count == 0) {
        stable_ = 0;
        stage_ = Stage::Track;
        if (seen_ != Seen::Nothing) {
            seen_ = Seen::Nothing;
            out.kind = SVC_VISION_NO_FACE;
        }
        return out;
    }
    const ai_engine_face_t &primary = largest(faces_, count);
    memcpy(out.primary.box, primary.box, sizeof(out.primary.box));
    follow(primary);
    if (side_of(primary.box) < static_cast<float>(thresholds_.face_min_px)) {
        stage_ = Stage::Track;
        if (seen_ != Seen::Small) {
            seen_ = Seen::Small;
            out.kind = SVC_VISION_FACE_SMALL;
        }
        return out;
    }
    seen_ = Seen::Face;
    switch (stage_) {
    case Stage::Track:
        if (stable_ >= kStableDetects && may_verify()) {
            begin(frame, primary);
        }
        break;
    case Stage::Liveness:
        liveness(out);
        break;
    case Stage::Embed:
        embed(out);
        break;
    }
    return out;
}

}  // namespace vision
