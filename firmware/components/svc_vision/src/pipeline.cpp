#include "vision.hpp"

#include <string.h>

#include "esp_log.h"

namespace vision {

namespace {

const char *TAG = "vision";

// Recognition runs only once the box has held still this many detects (KEHOACH 3, layer 5).
constexpr int kStableDetects = 2;
constexpr float kSameFaceIou = 0.5f;
// A verdict other than MATCH is retried after this many detects on the same
// track: 320 ms each, and six of them is a person standing still for 2.8 s.
constexpr int kRetryDetects = 3;
constexpr int kUnknownTries = 2;
// Enrolling asks liveness on every frame, so the number of tries is bounded.
constexpr int kEnrolSpoofTries = 3;
// The detector drops a frame here and there on a face that never moved.
constexpr int kMissesLost = 2;

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

// The 1.0x square fitted_box builds must fit whole, or the clamp pulls frame
// border into the crop and the spoof branch reads it as content (KEHOACH 3).
bool square_fits(const float *box, int width, int height) noexcept
{
    const float side = side_of(box);
    const float centre_x = (box[0] + box[2]) / 2.0f;
    const float centre_y = (box[1] + box[3]) / 2.0f;
    return centre_x - side / 2.0f >= 0.0f && centre_y - side / 2.0f >= 0.0f &&
           centre_x + side / 2.0f <= static_cast<float>(width) &&
           centre_y + side / 2.0f <= static_cast<float>(height);
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

// Projected on the eye axis rather than taken as a plain sideways offset, so a
// tilted head does not read as a turned one (KEHOACH 4.5.5h.2).
float yaw_of(const float landmarks[10]) noexcept
{
    const float eye_x = landmarks[2] - landmarks[0];
    const float eye_y = landmarks[3] - landmarks[1];
    const float span = eye_x * eye_x + eye_y * eye_y;
    if (span < 1.0f) {
        return 0.0f;
    }
    const float nose_x = landmarks[4] - (landmarks[0] + landmarks[2]) * 0.5f;
    const float nose_y = landmarks[5] - (landmarks[1] + landmarks[3]) * 0.5f;
    return (nose_x * eye_x + nose_y * eye_y) / span;
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
    enrol_spoofs_ = 0;
    unknown_tries_ = 0;
    tracking_ = false;
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
    // Overlap alone decides identity, so zeroing stable_ never ends a track.
    if (tracking_ && iou(tracked_, primary.box) >= kSameFaceIou) {
        ++stable_;
        if (since_verdict_ >= 0) {
            ++since_verdict_;
        }
    } else {
        stable_ = 1;
        since_verdict_ = -1;
        matched_ = false;
        ++track_;
        // A new track can be a different person, so the tries start over.
        enrol_spoofs_ = 0;
        unknown_tries_ = 0;
    }
    tracking_ = true;
    memcpy(tracked_, primary.box, sizeof(tracked_));
}

bool VisionPipeline::may_verify() const noexcept
{
    // An enrol needs the embedding of the face that just matched, and matched_
    // otherwise closes this path on that track for good.
    return (enrol_id_ != 0 && enrol_spoofs_ < kEnrolSpoofTries) || since_verdict_ < 0 ||
           (!matched_ && since_verdict_ >= kRetryDetects);
}

void VisionPipeline::verify(const ai_engine_frame_t &frame, const ai_engine_face_t &primary,
                            svc_vision_result_t &out) noexcept
{
    if (liveness_.available()) {
        float live = -1.0f;
        const esp_err_t scored = liveness_.score(frame, primary.box, &live);
        if (scored != ESP_OK) {
            // Every return below leaves the glass saying it is still working.
            ESP_LOGW(TAG, "no verdict: liveness %s", esp_err_to_name(scored));
            return;
        }
        out.live_score = live;
        if (live < thresholds_.live_min_score) {
            out.kind = SVC_VISION_SPOOF;
            matched_ = false;
            since_verdict_ = 0;
            ++enrol_spoofs_;
            return;
        }
    }
    float scale = 0.0f;
    const esp_err_t embedded = embedder_.embed(frame, primary.landmarks, embedding_,
                                               sizeof(embedding_), &scale);
    if (embedded != ESP_OK) {
        ESP_LOGW(TAG, "no verdict: embed %s", esp_err_to_name(embedded));
        return;
    }
    uint32_t employee_id = 0;
    float score = -1.0f;
    // A request outlives a table that refused the sample, so the next verified
    // frame tries again (KEHOACH 4.5.5d).
    const float turn = yaw_of(primary.landmarks);
    if (enrol_id_ != 0 && turn >= enrol_yaw_min_ && turn <= enrol_yaw_max_ &&
        matcher_.keep(embedding_, scale, enrol_id_, enrol_idx_, enrol_name_) == ESP_OK) {
        enrol_id_ = 0;
    }
    char name[STORAGE_NAME_CAP] = { 0 };
    const esp_err_t found = matcher_.best(embedding_, scale, &employee_id, &score, name, sizeof(name));
    // A table that never answered is not a verdict about this face (KEHOACH 5.3).
    if (found != ESP_OK && found != ESP_ERR_NOT_FOUND) {
        ESP_LOGW(TAG, "no verdict: facedb %s", esp_err_to_name(found));
        return;
    }
    out.match_score = score;
    matched_ = found == ESP_OK && score >= thresholds_.match_min_score;
    since_verdict_ = 0;
    if (matched_) {
        unknown_tries_ = 0;
        out.kind = SVC_VISION_MATCH;
        out.employee_id = employee_id;
        memcpy(out.name, name, sizeof(out.name));
        return;
    }
    // Refusing on the first sample calls an employee a stranger and grants them
    // a second later, because match_min drops 31% of genuine frames (KEHOACH 4.5.5d).
    if (++unknown_tries_ < kUnknownTries) {
        return;
    }
    out.kind = SVC_VISION_UNKNOWN;
}

void VisionPipeline::enrol_next(uint32_t employee_id, uint16_t template_idx, const char *name,
                                float yaw_min, float yaw_max) noexcept
{
    strlcpy(enrol_name_, name != nullptr ? name : "", sizeof(enrol_name_));
    enrol_idx_ = template_idx;
    enrol_yaw_min_ = yaw_min;
    enrol_yaw_max_ = yaw_max;
    enrol_spoofs_ = 0;
    enrol_id_ = employee_id;
}

void VisionPipeline::tell(const svc_vision_result_t &out, size_t count,
                          svc_vision_kind_t stage) noexcept
{
    if (seen_cb_ == nullptr) {
        return;
    }
    svc_vision_box_t boxes[SVC_VISION_REPORTED_FACES];
    uint8_t kept = 0;
    if (count > 0) {
        boxes[kept++] = out.primary;
        for (size_t i = 0; i < count && i < SVC_VISION_REPORTED_FACES &&
                           kept < SVC_VISION_REPORTED_FACES;
             ++i) {
            if (memcmp(faces_[i].box, out.primary.box, sizeof(boxes[0].box)) == 0) {
                continue;
            }
            memcpy(boxes[kept].box, faces_[i].box, sizeof(boxes[0].box));
            boxes[kept++].yaw = yaw_of(faces_[i].landmarks);
        }
    }
    seen_cb_(boxes, kept, track_, stage, seen_ctx_);
}

svc_vision_result_t VisionPipeline::step(const ai_engine_frame_t &frame) noexcept
{
    svc_vision_result_t out = blank();
    const size_t count = detector_.detect(frame, thresholds_.detect_min_score, faces_, kMaxFaces);
    out.faces = static_cast<uint8_t>(count);
    for (size_t i = 0; i < count && i < SVC_VISION_REPORTED_FACES; ++i) {
        memcpy(out.boxes[i].box, faces_[i].box, sizeof(out.boxes[i].box));
        out.boxes[i].yaw = yaw_of(faces_[i].landmarks);
    }
    if (count == 0) {
        if (++misses_ < kMissesLost) {
            return out;
        }
        stable_ = 0;
        tracking_ = false;
        tell(out, 0, SVC_VISION_NO_FACE);
        if (seen_ != Seen::Nothing) {
            seen_ = Seen::Nothing;
            out.kind = SVC_VISION_NO_FACE;
        }
        return out;
    }
    misses_ = 0;
    const ai_engine_face_t &primary = pick(count);
    memcpy(out.primary.box, primary.box, sizeof(out.primary.box));
    out.primary.yaw = yaw_of(primary.landmarks);
    follow(primary);
    // Three arithmetic checks scored here so the glass learns the stage on the
    // fast path, not after the slow models return (KEHOACH 4.5.5h.1).
    const bool small = side_of(primary.box) < static_cast<float>(thresholds_.face_min_px);
    const bool fits = square_fits(primary.box, frame.width, frame.height);
    // Saying FACE_OK is saying a model runs this step, and only this line knows
    // whether one will (KEHOACH 4.5.5h.1).
    const bool working = stable_ >= kStableDetects ? may_verify() : true;
    const svc_vision_kind_t settled = working ? SVC_VISION_FACE_OK : SVC_VISION_FACE_SETTLED;
    const svc_vision_kind_t stage =
        small ? SVC_VISION_FACE_SMALL : (fits ? settled : SVC_VISION_FACE_OUT_OF_FRAME);
    // The slow models below hold this step for up to a second, and a box that
    // waits for them is a second old by the time it is drawn (KEHOACH 4.5.5d).
    tell(out, count, stage);
    if (small) {
        if (seen_ != Seen::Small) {
            seen_ = Seen::Small;
            out.kind = SVC_VISION_FACE_SMALL;
        }
        return out;
    }
    if (!fits) {
        stable_ = 0;
        if (seen_ != Seen::Edge) {
            seen_ = Seen::Edge;
            out.kind = SVC_VISION_FACE_OUT_OF_FRAME;
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
