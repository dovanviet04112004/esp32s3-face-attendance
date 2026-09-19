#include "app_wiring.h"

#include "app_events.h"
#include "esp_camera.h"
#include "esp_log.h"
#include "gen_payload.h"
#include "storage_format.h"
#include "svc_vision.h"

static const char *TAG = "app_wiring";

#define FRAME_DEPTH 1
#define RESULT_DEPTH 4
#define PRESENCE_DEPTH 2
#define SOUND_DEPTH 4
#define UPLINK_DEPTH 16
// Full means the kiosk is already busy, and a command queue that waited would
// hold the esp-mqtt task and the attendance going up with it.
#define COMMAND_DEPTH 4
#define EVENT_DEPTH 8
// One image installs at a time, so a second manifest in flight is redundant.
#define OTA_DEPTH 1
// Three templates of one person go out together, so two is one short.
#define ROSTER_DEPTH 4

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
    s_wiring.commands = xQueueCreate(COMMAND_DEPTH, sizeof(device_command_t));
    s_wiring.events = xQueueCreate(EVENT_DEPTH, sizeof(app_event_t));
    s_wiring.roster = xQueueCreate(ROSTER_DEPTH, sizeof(app_roster_t));
    s_wiring.ota = xQueueCreate(OTA_DEPTH, sizeof(ota_manifest_t));
    s_wiring.flags = xEventGroupCreate();
    if (s_wiring.frames == NULL || s_wiring.results == NULL || s_wiring.presence == NULL ||
        s_wiring.sounds == NULL || s_wiring.uplink == NULL || s_wiring.commands == NULL ||
        s_wiring.events == NULL || s_wiring.roster == NULL || s_wiring.ota == NULL ||
        s_wiring.flags == NULL) {
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
