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
    return out;
}

}  // namespace

void VisionPipeline::reset() noexcept
{
    stable_ = 0;
    since_verdict_ = -1;
    matched_ = false;
    seen_ = Seen::Nothing;
}

const ai_engine_face_t &VisionPipeline::pick(size_t count) const noexcept
{
    // The face already followed keeps its turn while it is still there; a larger
    // newcomer only takes over once it is lost (KEHOACH 4.5.5d).
    if (stable_ > 0) {
        size_t best = count;
        float best_iou = kSameFaceIou;
        for (size_t i = 0; i < count; ++i) {
            const float overlap = iou(tracked_, faces_[i].box);
            if (overlap >= best_iou) {
                best_iou = overlap;
                best = i;
            }
        }
        if (best < count) {
            return faces_[best];
        }
    }
    return largest(faces_, count);
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
    }
    memcpy(tracked_, primary.box, sizeof(tracked_));
}

bool VisionPipeline::may_verify() const noexcept
{
    return since_verdict_ < 0 || (!matched_ && since_verdict_ >= kRetryDetects);
}

void VisionPipeline::verify(const ai_engine_frame_t &frame, const ai_engine_face_t &primary,
                            svc_vision_result_t &out) noexcept
{
    if (liveness_.available()) {
        float live = -1.0f;
        if (liveness_.score(frame, primary.box, &live) != ESP_OK) {
            return;
        }
        out.live_score = live;
        if (live < thresholds_.live_min_score) {
            out.kind = SVC_VISION_SPOOF;
            matched_ = false;
            since_verdict_ = 0;
            return;
        }
    }
    float scale = 0.0f;
    if (embedder_.embed(frame, primary.landmarks, embedding_, sizeof(embedding_), &scale) != ESP_OK) {
        return;
    }
    uint32_t employee_id = 0;
    float score = -1.0f;
    const esp_err_t found = matcher_.best(embedding_, scale, &employee_id, &score);
    out.match_score = score;
    matched_ = found == ESP_OK && score >= thresholds_.match_min_score;
    since_verdict_ = 0;
    if (matched_) {
        out.kind = SVC_VISION_MATCH;
        out.employee_id = employee_id;
        return;
    }
    out.kind = SVC_VISION_UNKNOWN;
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
        if (seen_ != Seen::Nothing) {
            seen_ = Seen::Nothing;
            out.kind = SVC_VISION_NO_FACE;
        }
        return out;
    }
    const ai_engine_face_t &primary = pick(count);
    memcpy(out.primary.box, primary.box, sizeof(out.primary.box));
    follow(primary);
    if (side_of(primary.box) < static_cast<float>(thresholds_.face_min_px)) {
        if (seen_ != Seen::Small) {
            seen_ = Seen::Small;
            out.kind = SVC_VISION_FACE_SMALL;
        }
        return out;
    }
    seen_ = Seen::Face;
    if (stable_ >= kStableDetects && may_verify()) {
        verify(frame, primary, out);
    }
    return out;
}

}  // namespace vision
