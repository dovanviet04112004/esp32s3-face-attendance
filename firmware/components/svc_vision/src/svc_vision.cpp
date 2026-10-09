#include "svc_vision.h"

#include <string.h>

#include <atomic>

#include "backends.hpp"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"

namespace {

const char *TAG = "svc_vision";

vision::AiDetector s_detector;
vision::AiLiveness s_liveness;
vision::AiEmbedder s_embedder;
vision::FacedbMatcher s_matcher;
vision::VisionPipeline s_pipeline(s_detector, s_liveness, s_embedder, s_matcher);
bool s_ready;

struct Asks {
    bool reset;
    bool cancel;
    bool enrol;
    uint32_t employee_id;
    uint16_t template_idx;
    char name[STORAGE_NAME_CAP];
    float yaw_min;
    float yaw_max;
};

// The pipeline belongs to ai_task; other tasks leave asks here for its next step (KEHOACH 4.5.5d).
portMUX_TYPE s_asks_lock = portMUX_INITIALIZER_UNLOCKED;
Asks s_asks;
std::atomic<bool> s_wanted{ false };      // a face is asked for and not kept yet
std::atomic<uint32_t> s_begun{ 0 };       // steps that took their asks
std::atomic<uint32_t> s_ended{ 0 };       // number of the last step that finished

uint32_t take_asks() noexcept
{
    portENTER_CRITICAL(&s_asks_lock);
    const Asks taken = s_asks;
    s_asks = Asks{};
    const uint32_t step = s_begun.fetch_add(1) + 1;
    portEXIT_CRITICAL(&s_asks_lock);
    if (taken.reset) {
        s_pipeline.reset();
    }
    if (taken.cancel) {
        s_pipeline.enrol_cancel();
    }
    if (taken.enrol) {
        s_pipeline.enrol_next(taken.employee_id, taken.template_idx, taken.name, taken.yaw_min, taken.yaw_max);
    }
    return step;
}

bool sane(const svc_vision_thresholds_t &t)
{
    return t.detect_min_score > 0.0f && t.detect_min_score < 1.0f && t.live_min_score >= 0.0f &&
           t.live_min_score <= 1.0f && t.match_min_score > -1.0f && t.match_min_score <= 1.0f && t.face_min_px > 0 &&
           t.guide[2] > t.guide[0] && t.guide[3] > t.guide[1] && t.guide_min_share > 0.0f &&
           t.guide_min_share <= 1.0f;
}

}  // namespace

int s_face_min_px;

extern "C" esp_err_t svc_vision_init(const svc_vision_thresholds_t *thresholds)
{
    if (s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    if (thresholds == nullptr || !sane(*thresholds)) {
        return ESP_ERR_INVALID_ARG;
    }
    if (ai_engine_recog_input_bytes() == 0) {
        ESP_LOGE(TAG, "the image on models_0 carries no recognition branch");
        return ESP_ERR_NOT_FOUND;
    }
    s_pipeline.configure(*thresholds);
    s_face_min_px = thresholds->face_min_px;
    s_ready = true;
    ESP_LOGI(TAG, "detect >= %.2f, live >= %.2f%s, match >= %.2f, face >= %d px", thresholds->detect_min_score,
             thresholds->live_min_score, s_liveness.available() ? "" : " (no spoof branch, skipped)",
             thresholds->match_min_score, thresholds->face_min_px);
    ESP_LOGI(TAG, "guide x %.0f-%.0f y %.0f-%.0f, %.0f%% of a face inside", thresholds->guide[0],
             thresholds->guide[2], thresholds->guide[1], thresholds->guide[3],
             thresholds->guide_min_share * 100.0f);
    return ESP_OK;
}

extern "C" void svc_vision_on_seen(svc_vision_seen_cb_t cb, void *ctx)
{
    s_pipeline.observe(cb, ctx);
}

extern "C" esp_err_t svc_vision_enrol_next(uint32_t employee_id, uint16_t template_idx,
                                           const char *name, float yaw_min, float yaw_max)
{
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    portENTER_CRITICAL(&s_asks_lock);
    s_asks.enrol = true;
    s_asks.employee_id = employee_id;
    s_asks.template_idx = template_idx;
    strlcpy(s_asks.name, name != nullptr ? name : "", sizeof(s_asks.name));
    s_asks.yaw_min = yaw_min;
    s_asks.yaw_max = yaw_max;
    s_wanted.store(true);
    portEXIT_CRITICAL(&s_asks_lock);
    return ESP_OK;
}

extern "C" bool svc_vision_enrol_pending(void)
{
    return s_ready && s_wanted.load();
}

extern "C" uint32_t svc_vision_enrol_cancel(void)
{
    portENTER_CRITICAL(&s_asks_lock);
    s_asks.cancel = true;
    s_asks.enrol = false;
    s_wanted.store(false);
    const uint32_t ticket = s_begun.load();
    portEXIT_CRITICAL(&s_asks_lock);
    return ticket;
}

extern "C" bool svc_vision_settled(uint32_t ticket)
{
    return static_cast<int32_t>(s_ended.load() - ticket) >= 0;
}

extern "C" int svc_vision_face_min_px(void)
{
    return s_ready ? s_face_min_px : 0;
}

extern "C" esp_err_t svc_vision_step(const camera_fb_t *frame, svc_vision_result_t *out)
{
    if (!s_ready || frame == nullptr || out == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    if (frame->format != PIXFORMAT_RGB565 || frame->buf == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    const uint32_t step = take_asks();
    const ai_engine_frame_t view = {
        .pixels = reinterpret_cast<const uint16_t *>(frame->buf),
        .width = static_cast<int>(frame->width),
        .height = static_cast<int>(frame->height),
        .high_byte_first = true,
    };
    *out = s_pipeline.step(view);
    // An ask posted during this step is still owed a face, whatever this step kept.
    portENTER_CRITICAL(&s_asks_lock);
    if (!s_asks.enrol && !s_pipeline.enrol_pending()) {
        s_wanted.store(false);
    }
    portEXIT_CRITICAL(&s_asks_lock);
    s_ended.store(step);
    return ESP_OK;
}

extern "C" void svc_vision_reset(void)
{
    portENTER_CRITICAL(&s_asks_lock);
    s_asks.reset = true;
    portEXIT_CRITICAL(&s_asks_lock);
}
