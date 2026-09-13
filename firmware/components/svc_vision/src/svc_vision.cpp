#include "svc_vision.h"

#include "backends.hpp"
#include "esp_log.h"

namespace {

const char *TAG = "svc_vision";

vision::AiDetector s_detector;
vision::AiLiveness s_liveness;
vision::AiEmbedder s_embedder;
vision::FacedbMatcher s_matcher;
vision::VisionPipeline s_pipeline(s_detector, s_liveness, s_embedder, s_matcher);
bool s_ready;

bool sane(const svc_vision_thresholds_t &t)
{
    return t.detect_min_score > 0.0f && t.detect_min_score < 1.0f && t.live_min_score >= 0.0f &&
           t.live_min_score <= 1.0f && t.match_min_score > -1.0f && t.match_min_score <= 1.0f && t.face_min_px > 0;
}

}  // namespace

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
    s_ready = true;
    ESP_LOGI(TAG, "detect >= %.2f, live >= %.2f%s, match >= %.2f, face >= %d px", thresholds->detect_min_score,
             thresholds->live_min_score, s_liveness.available() ? "" : " (no spoof branch, skipped)",
             thresholds->match_min_score, thresholds->face_min_px);
    return ESP_OK;
}

extern "C" void svc_vision_on_seen(svc_vision_seen_cb_t cb, void *ctx)
{
    s_pipeline.observe(cb, ctx);
}

extern "C" esp_err_t svc_vision_step(const camera_fb_t *frame, svc_vision_result_t *out)
{
    if (!s_ready || frame == nullptr || out == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    if (frame->format != PIXFORMAT_RGB565 || frame->buf == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    const ai_engine_frame_t view = {
        .pixels = reinterpret_cast<const uint16_t *>(frame->buf),
        .width = static_cast<int>(frame->width),
        .height = static_cast<int>(frame->height),
        .high_byte_first = true,
    };
    *out = s_pipeline.step(view);
    return ESP_OK;
}

extern "C" void svc_vision_reset(void)
{
    s_pipeline.reset();
}
