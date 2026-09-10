#include "app_wiring.h"

#include "app_events.h"
#include "esp_camera.h"
#include "esp_log.h"
#include "storage_format.h"
#include "svc_vision.h"

static const char *TAG = "app_wiring";

#define FRAME_DEPTH 1
#define RESULT_DEPTH 4
#define PRESENCE_DEPTH 2
#define SOUND_DEPTH 4
#define UPLINK_DEPTH 16

static app_wiring_t s_wiring;
static bool s_ready;

esp_err_t app_wiring_init(void)
{
    if (s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    s_wiring.frames = xQueueCreate(FRAME_DEPTH, sizeof(camera_fb_t *));
    s_wiring.results = xQueueCreate(RESULT_DEPTH, sizeof(svc_vision_result_t));
    s_wiring.presence = xQueueCreate(PRESENCE_DEPTH, sizeof(app_presence_t));
    s_wiring.sounds = xQueueCreate(SOUND_DEPTH, sizeof(app_sound_t));
    s_wiring.uplink = xQueueCreate(UPLINK_DEPTH, sizeof(storage_attend_record_t));
    s_wiring.flags = xEventGroupCreate();
    if (s_wiring.frames == NULL || s_wiring.results == NULL || s_wiring.presence == NULL ||
        s_wiring.sounds == NULL || s_wiring.uplink == NULL || s_wiring.flags == NULL) {
        return ESP_ERR_NO_MEM;
    }
    s_ready = true;
    ESP_LOGI(TAG, "queues up: %u B of results, %u B of uplink",
             (unsigned)(RESULT_DEPTH * sizeof(svc_vision_result_t)),
             (unsigned)(UPLINK_DEPTH * sizeof(storage_attend_record_t)));
    return ESP_OK;
}

const app_wiring_t *app_wiring(void)
{
    return s_ready ? &s_wiring : NULL;
}
