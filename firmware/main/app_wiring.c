#include "app_wiring.h"

#include "app_events.h"
#include "esp_camera.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "gen_payload.h"
#include "sdkconfig.h"
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
// A resync is a REPLACE_ALL, an UPSERT per template the table holds and an ASSIGN
// per pending row; the spare takes the operator's own asks (KEHOACH 9.23).
#define ROSTER_SPARE 8
#define ROSTER_DEPTH (CONFIG_FACEDB_MAX_RECORDS + STORAGE_PENDING_CAP + ROSTER_SPARE)

static app_wiring_t s_wiring;
static StaticQueue_t s_roster_queue;
static bool s_ready;

// Over half a megabyte of decoded pushes, so the items live in PSRAM.
static QueueHandle_t make_roster_queue(void)
{
    uint8_t *items = heap_caps_malloc(ROSTER_DEPTH * sizeof(app_roster_t), MALLOC_CAP_SPIRAM);
    if (items == NULL) {
        return NULL;
    }
    return xQueueCreateStatic(ROSTER_DEPTH, sizeof(app_roster_t), items, &s_roster_queue);
}

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
    s_wiring.roster = make_roster_queue();
    s_wiring.ota = xQueueCreate(OTA_DEPTH, sizeof(ota_manifest_t));
    s_wiring.flags = xEventGroupCreate();
    if (s_wiring.frames == NULL || s_wiring.results == NULL || s_wiring.presence == NULL ||
        s_wiring.sounds == NULL || s_wiring.uplink == NULL || s_wiring.commands == NULL ||
        s_wiring.events == NULL || s_wiring.roster == NULL || s_wiring.ota == NULL ||
        s_wiring.flags == NULL) {
        return ESP_ERR_NO_MEM;
    }
    s_ready = true;
    ESP_LOGI(TAG, "queues up: %u B of results, %u B of uplink, %u roster ops in %u B of psram",
             (unsigned)(RESULT_DEPTH * sizeof(svc_vision_result_t)),
             (unsigned)(UPLINK_DEPTH * sizeof(storage_attend_record_t)), (unsigned)ROSTER_DEPTH,
             (unsigned)(ROSTER_DEPTH * sizeof(app_roster_t)));
    return ESP_OK;
}

const app_wiring_t *app_wiring(void)
{
    return s_ready ? &s_wiring : NULL;
}
