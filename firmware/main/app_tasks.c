#include "app_tasks.h"

#include <inttypes.h>
#include <stdatomic.h>
#include <string.h>

#include "ai_engine.h"
#include "app_config.h"
#include "app_events.h"
#include "app_wiring.h"
#include "drv_audio.h"
#include "drv_camera.h"
#include "drv_lcd.h"
#include "drv_tof.h"
#include "drv_touch.h"
#include "esp_heap_caps.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "net_mqtt.h"
#include "net_ota.h"
#include "net_provision.h"
#include "net_wifi.h"
#include "storage_format.h"
#include "svc_attendance.h"
#include "svc_facedb.h"
#include "svc_sync.h"
#include "gen_payload.h"
#include "mbedtls/base64.h"
#include "svc_vision.h"
#include "sys_storage.h"
#include "sys_time.h"
#include "ui_kiosk.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "app_tasks";

// What frame the pipeline is holding, so its observer can stamp the boxes.
static int s_seen_width;
static int s_seen_height;
static _Atomic int64_t s_awake_at_ms;
static _Atomic uint32_t s_gate_mm;

// Nobody in front means no model runs at all, which is where most of the
// energy goes (KEHOACH 3 layer 5).
static const char *_Atomic s_awake_by = "boot";

static void stay_awake(const char *why)
{
    atomic_store(&s_awake_by, why);
    atomic_store(&s_awake_at_ms, esp_timer_get_time() / 1000);
}

// Elapsed time only, so the clock sntp steps must not be the one asked.
static int64_t asleep_for_ms(void)
{
    return esp_timer_get_time() / 1000 - atomic_load(&s_awake_at_ms);
}

typedef enum { REST_NONE, REST_ALL } rest_t;

#define CAM_TASK_CORE 0
#define CAM_TASK_PRIORITY 7
#define CAM_TASK_STACK_BYTES 4096
#define RATE_WINDOW_FRAMES 60
#define COVER_WAIT_MS 70
#define TOF_TASK_CORE 0
#define TOF_TASK_PRIORITY 6
#define TOF_TASK_STACK_BYTES 3072
#define TOF_POLL_MS 100
#define PRESENCE_WAIT_MS 50
#define SOUND_WAIT_MS 20
#define REST_ALL_MS 60000
#define REST_POLL_MS 40
#define SCREEN_DIM_PERCENT 0
#define WIFI_NVS_SSID "ssid"
#define UI_NVS_BRIGHTNESS "brightness"
#define UI_NVS_VOLUME "volume"
#define UI_NVS_LANGUAGE "lang"
#define TOF_SETTLE_POLLS 5
#define PRESENCE_HYSTERESIS_MM 60
#define PRESENCE_AWAY_SAMPLES 5
#define AI_TASK_CORE 1
#define AI_TASK_PRIORITY 5
#define AI_TASK_STACK_BYTES 8192
#define FRAME_WAIT_MS 2000
#define RESULT_WAIT_MS 100
#define ATTEND_TASK_CORE 0
#define ATTEND_TASK_PRIORITY 4
#define ATTEND_TASK_STACK_BYTES 4096
#define ATTEND_TICK_MS 200
#define SETTINGS_REFRESH_MS 3000
#define FACT_LABEL_CAP 24
#define FACT_VALUE_CAP 32
#define SYNC_TASK_CORE 0
#define SYNC_TASK_PRIORITY 2
#define SYNC_TASK_STACK_BYTES 5120
#define SYNC_POLL_MS 5000
#define SYNC_REPORT_BATCHES 8
#define HEARTBEAT_PAYLOAD_CAP 384
#define MODEL_VERSION_CAP 33
#define NVS_MODEL_VERSION "version"
#define NVS_ACTIVE_SLOT "active_slot"
#define NVS_ROSTER_VER "roster_ver"
#define EMBEDDING_VERSION_CAP 33
#define MODEL_ENTRY_RECOG "recog"
#define EVENT_PAYLOAD_CAP 384
#define CMD_SEEN_RING 8
#define SYNC_TICK_MS 250
#define OPEN_DOOR_DEFAULT_MS 3000
#define REBOOT_DRAIN_MS 400
#define WIFI_JOIN_WAIT_MS 12000
#define ENROLL_REPORT_CAP 1024
#define ENROL_SAMPLES 3
#define ROSTER_OFFER_WAIT_MS 200
#define EVENT_FAULT_GAP_MS 60000
#define EVENT_PERSON_GAP_MS 2000
#define NET_TASK_CORE 0
#define OTA_TASK_CORE 0
#define OTA_TASK_PRIORITY 3
#define OTA_TASK_STACK_BYTES 8192
#define OTA_SETTLE_MS 30000
#define OTA_REBOOT_WAIT_MS 1500
#define NVS_LAST_OTA "last_ota_result"
#define OTA_MODELS_ON_TRIAL 1u
#define TICKET_POLL_MS 1000
#define TICKET_RECHECK_MS 60000
#define NET_TASK_PRIORITY 3
#define NET_TASK_STACK_BYTES 4096
#define JOIN_WAIT_MS 30000
#define SNTP_HOST_CAP 64
#define NVS_SNTP_HOST "sntp_host"
#define NVS_RTC_NTP_SET "rtc_ntp_set"
#define NVS_PRESENT_MM "present_mm"
#define TOUCH_TASK_CORE 0
#define TOUCH_TASK_PRIORITY 5
#define TOUCH_TASK_STACK_BYTES 3072
#define TOUCH_POLL_MS 40
#define TOUCH_IDLE_WAIT_MS 1000
#define TOUCH_POINTS 1
#define UI_TASK_CORE 0
#define UI_TASK_PRIORITY 4
#define UI_TASK_STACK_BYTES 4096
#define UI_TICK_MS 20
#define UI_REST_TICK_MS 200
#define AUDIO_TASK_CORE 0
#define AUDIO_TASK_PRIORITY 6
#define AUDIO_TASK_STACK_BYTES 4096
#define AUDIO_CLIP_PATH "/assets/snd/ok.wav"
#define AUDIO_CLIP_CAP_BYTES (128 * 1024)
#define WAV_HEADER_MIN 44

// A screen that covers the panel and the enrolment screen both hold the kiosk
// open, and neither of them is a wake source (KEHOACH 5.4).
static rest_t rest_level(void)
{
    if (ui_kiosk_screen_covers() || ui_kiosk_enrolling()) {
        return REST_NONE;
    }
    return asleep_for_ms() > REST_ALL_MS ? REST_ALL : REST_NONE;
}

static void report_rate(int frames, int64_t elapsed_us)
{
    const int mfps = elapsed_us > 0 ? (int)((int64_t)frames * 1000000000 / elapsed_us) : 0;
    int level = 0, exposure = 0, gain16 = 0;
    drv_camera_exposure_state(&level, &exposure, &gain16);
    ESP_LOGI(TAG, "preview %d.%03d fps, blit %" PRIu32 " us, level %d, exposure %d lines, gain %d/16",
             mfps / 1000, mfps % 1000, drv_lcd_blit_us(), level, exposure, gain16);
}

// The marker is what tells a later boot that this clock has been verified, and
// only sys_storage may write it (KEHOACH 6.2.5).
static void on_time_synced(void *arg)
{
    (void)arg;
    const esp_err_t err = sys_storage_set_u32(STORAGE_NS_SYS, NVS_RTC_NTP_SET, 1);
    ESP_LOGI(TAG, "time verified, marker %s", esp_err_to_name(err));
    const app_wiring_t *wiring = app_wiring();
    if (wiring != NULL) {
        xEventGroupSetBits(wiring->flags, APP_EG_TIME_OK);
    }
}

// A broken sensor repeats, a person does not: one fault every minute is enough
// to show it is stuck, while two spoof tries five seconds apart are two tries.
static int64_t event_gap_ms(int type)
{
    return type == DEVICE_EVENT_TYPE_SPOOF_DETECTED || type == DEVICE_EVENT_TYPE_UNKNOWN_FACE
               ? EVENT_PERSON_GAP_MS
               : EVENT_FAULT_GAP_MS;
}

// The valve sits with the producer so one stuck sensor never fills the queue.
static void note_event(const app_event_t *event)
{
    static int64_t last_ms[DEVICE_EVENT_TYPE_COUNT];
    const app_wiring_t *wiring = app_wiring();
    if (wiring == NULL || event->type < 0 || event->type >= DEVICE_EVENT_TYPE_COUNT) {
        return;
    }
    const int64_t now_ms = esp_timer_get_time() / 1000;
    if (last_ms[event->type] != 0 && now_ms - last_ms[event->type] < event_gap_ms(event->type)) {
        return;
    }
    last_ms[event->type] = now_ms;
    if (xQueueSend(wiring->events, event, 0) != pdTRUE) {
        ESP_LOGW(TAG, "event %d dropped, queue full", event->type);
    }
}

// A refused face is a fact the server wants, and the score that refused it is
// the only way to tell a photograph from a bad frame.
static void note_verdict(const svc_vision_result_t *result)
{
    app_event_t event = { 0 };
    if (result->kind == SVC_VISION_SPOOF) {
        event.type = DEVICE_EVENT_TYPE_SPOOF_DETECTED;
        event.severity = DEVICE_EVENT_SEVERITY_WARN;
        event.liveness = result->live_score;
        event.has_liveness = true;
        strlcpy(event.note, "liveness below the floor", sizeof(event.note));
    } else if (result->kind == SVC_VISION_UNKNOWN) {
        event.type = DEVICE_EVENT_TYPE_UNKNOWN_FACE;
        event.severity = DEVICE_EVENT_SEVERITY_INFO;
        strlcpy(event.note, "no template close enough", sizeof(event.note));
    } else {
        return;
    }
    note_event(&event);
}

static void note_fault(int type, esp_err_t err, const char *note)
{
    app_event_t event = { 0 };
    event.type = type;
    event.severity = DEVICE_EVENT_SEVERITY_ERROR;
    event.error_code = (int32_t)err;
    event.has_error = true;
    strlcpy(event.note, note, sizeof(event.note));
    note_event(&event);
}

// Same code for a dead ticket and a silent api, so ota_task asks api to tell them apart (KEHOACH 7.3).
static void on_broker_refused(void *ctx)
{
    (void)ctx;
    const app_wiring_t *wiring = app_wiring();
    if (wiring != NULL) {
        xEventGroupSetBits(wiring->flags, APP_EG_BROKER_REFUSED);
    }
}

static void on_broker_state(bool up, void *ctx)
{
    (void)ctx;
    const app_wiring_t *wiring = app_wiring();
    if (wiring == NULL) {
        return;
    }
    svc_attendance_set_link(up);
    if (up) {
        xEventGroupSetBits(wiring->flags, APP_EG_MQTT_OK);
    } else {
        xEventGroupClearBits(wiring->flags, APP_EG_MQTT_OK);
    }
}

// A template made by another recognition model must be refused rather than
// compared across models, so both sides need the same name for this one.
static void embedding_version(char *out, size_t cap)
{
    const storage_models_header_t *header = NULL;
    if (sys_storage_models_open(&header) == ESP_OK && header != NULL) {
        for (uint32_t i = 0; i < header->count && i < STORAGE_MODEL_COUNT; ++i) {
            if (strcmp(header->entry[i].name, MODEL_ENTRY_RECOG) != 0) {
                continue;
            }
            const uint8_t *sha = header->entry[i].sha256;
            snprintf(out, cap, "recog-%02x%02x%02x%02x%02x%02x%02x%02x", sha[0], sha[1], sha[2],
                     sha[3], sha[4], sha[5], sha[6], sha[7]);
            return;
        }
    }
    strlcpy(out, "none", cap);
}

static uint32_t roster_version(void)
{
    uint32_t version = 0;
    sys_storage_get_u32(STORAGE_NS_DEVICE, NVS_ROSTER_VER, &version);
    return version;
}

static void take_roster_push(const char *payload, size_t len)
{
    cJSON *root = cJSON_ParseWithLength(payload, len);
    enroll_payload_t wire = { 0 };
    const bool understood = root != NULL && enroll_payload_from_json(root, &wire);
    cJSON_Delete(root);
    if (!understood) {
        ESP_LOGW(TAG, "roster push does not match the schema, dropped");
        return;
    }
    app_roster_t op = { 0 };
    op.op = wire.op;
    op.employee_id = wire.employee_id;
    op.template_idx = wire.template_idx;
    op.quality = wire.has_quality ? wire.quality : 0;
    op.scale = wire.scale;
    op.updated_at = wire.updated_at;
    op.roster_version = (uint32_t)wire.roster_version;
    op.has_roster_version = wire.has_roster_version;
    if (wire.has_full_name) {
        strlcpy(op.name, wire.full_name, sizeof(op.name));
    }
    if (wire.op == ENROLL_PAYLOAD_OP_UPSERT) {
        char mine[EMBEDDING_VERSION_CAP] = { 0 };
        embedding_version(mine, sizeof(mine));
        if (strcmp(mine, wire.embedding_version) != 0) {
            // Comparing across models is worse than refusing (KEHOACH 7.5).
            app_event_t refused = { 0 };
            refused.type = DEVICE_EVENT_TYPE_ROSTER_REJECTED;
            refused.severity = DEVICE_EVENT_SEVERITY_WARN;
            refused.employee_id = wire.employee_id;
            refused.has_employee = true;
            snprintf(refused.note, sizeof(refused.note), "kiosk embeds %.*s",
                     (int)sizeof(refused.note) - 16, mine);
            note_event(&refused);
            return;
        }
        size_t got = 0;
        if (mbedtls_base64_decode((unsigned char *)op.embedding, sizeof(op.embedding), &got,
                                  (const unsigned char *)wire.embedding,
                                  strlen(wire.embedding)) != 0 ||
            got != sizeof(op.embedding)) {
            ESP_LOGW(TAG, "roster embedding is %u bytes, want %u", (unsigned)got,
                     (unsigned)sizeof(op.embedding));
            return;
        }
    }
    const app_wiring_t *wiring = app_wiring();
    if (wiring == NULL || xQueueSend(wiring->roster, &op, 0) != pdTRUE) {
        ESP_LOGE(TAG, "roster op for %" PRIu32 " dropped, queue full", op.employee_id);
    }
}

// Same rule as a command: the callback parses and hands over, because pulling a
// firmware image takes tens of seconds and this task carries the whole link.
static void take_ota_offer(const char *payload, size_t len)
{
    cJSON *root = cJSON_ParseWithLength(payload, len);
    ota_manifest_t offer = { 0 };
    const bool understood = root != NULL && ota_manifest_from_json(root, &offer);
    cJSON_Delete(root);
    if (!understood) {
        ESP_LOGW(TAG, "ota manifest does not match the schema, dropped");
        return;
    }
    const app_wiring_t *wiring = app_wiring();
    if (wiring == NULL || xQueueSend(wiring->ota, &offer, 0) != pdTRUE) {
        ESP_LOGW(TAG, "ota offer %s dropped, one is already in hand", offer.release_id);
    }
}

// Runs on the esp-mqtt task, which must not block: parse here, act in sync_task.
static void on_broker_message(gen_topic_id_t topic, const char *payload, size_t len, void *ctx)
{
    (void)ctx;
    if (topic == GEN_TOPIC_ENROLL) {
        take_roster_push(payload, len);
        return;
    }
    if (topic == GEN_TOPIC_OTA) {
        take_ota_offer(payload, len);
        return;
    }
    if (topic != GEN_TOPIC_CMD) {
        ESP_LOGI(TAG, "topic %d, %u bytes, nothing consumes it yet", (int)topic, (unsigned)len);
        return;
    }
    cJSON *root = cJSON_ParseWithLength(payload, len);
    device_command_t cmd = { 0 };
    const bool understood = root != NULL && device_command_from_json(root, &cmd);
    cJSON_Delete(root);
    if (!understood) {
        ESP_LOGW(TAG, "command does not match the schema, dropped");
        return;
    }
    const app_wiring_t *wiring = app_wiring();
    if (wiring == NULL || xQueueSend(wiring->commands, &cmd, 0) != pdTRUE) {
        ESP_LOGE(TAG, "command %s dropped, queue full", cmd.cmd_id);
    }
}

static void start_broker(void)
{
    const net_mqtt_config_t broker = {
        .on_state = on_broker_state,
        .on_message = on_broker_message,
        .on_refused = on_broker_refused,
    };
    const esp_err_t link = net_mqtt_start(&broker);
    if (link != ESP_OK) {
        ESP_LOGW(TAG, "no broker: %s", esp_err_to_name(link));
    }
}

// A build that cannot state its own MAJOR.MINOR.PATCH cannot claim it meets a
// minimum, so an unparseable version fails the test (KEHOACH 6.2.2).
static bool fw_at_least(const char *wanted)
{
    const esp_app_desc_t *app = esp_app_get_description();
    unsigned mine[3] = { 0 };
    unsigned theirs[3] = { 0 };
    if (app == NULL || sscanf(app->version, "%u.%u.%u", &mine[0], &mine[1], &mine[2]) != 3 ||
        sscanf(wanted, "%u.%u.%u", &theirs[0], &theirs[1], &theirs[2]) != 3) {
        return false;
    }
    for (int i = 0; i < 3; ++i) {
        if (mine[i] != theirs[i]) {
            return mine[i] > theirs[i];
        }
    }
    return true;
}

// A key present but empty is the same as absent, so the fallback wins (KEHOACH 6.2.1).
static void sntp_host(char *out, size_t cap)
{
    if (sys_storage_get_str(STORAGE_NS_DEVICE, NVS_SNTP_HOST, out, cap) != ESP_OK ||
        out[0] == '\0') {
        strlcpy(out, CONFIG_APP_SNTP_DEFAULT_HOST, cap);
    }
}

// One shot: the clock needs a netif, so the wait belongs off app_main and the
// task leaves once the correction is under way.
static void net_task(void *arg)
{
    (void)arg;
    // A fresh kiosk gets its wifi from the installer on the screen, often long after boot (KEHOACH 7.3).
    for (bool told = false; net_wifi_wait_connected(JOIN_WAIT_MS) != ESP_OK; told = true) {
        if (!told) {
            ESP_LOGW(TAG, "no link in %d ms, clock stays on the rtc until one comes", JOIN_WAIT_MS);
        }
    }
    const app_wiring_t *wiring = app_wiring();
    xEventGroupSetBits(wiring->flags, APP_EG_WIFI_OK);
    // No login means no broker yet: ota_task fetches the ticket first (KEHOACH 7.3).
    if (net_mqtt_login() == NET_MQTT_LOGIN_NONE) {
        xEventGroupSetBits(wiring->flags, APP_EG_NEED_TICKET);
    } else {
        start_broker();
    }
    char host[SNTP_HOST_CAP] = { 0 };
    sntp_host(host, sizeof(host));
    const esp_err_t sync = sys_time_sync_start(host, on_time_synced, NULL);
    ESP_LOGI(TAG, "sntp against %s: %s", host, esp_err_to_name(sync));
    vTaskDelete(NULL);
}

// Until OTA writes model/version the image's own digest is the honest answer:
// the header crc covers all three model hashes (KEHOACH 7.1).
static void model_version(char *out, size_t cap)
{
    if (sys_storage_get_str(STORAGE_NS_MODEL, NVS_MODEL_VERSION, out, cap) == ESP_OK &&
        out[0] != '\0') {
        return;
    }
    const storage_models_header_t *header = NULL;
    if (sys_storage_models_open(&header) == ESP_OK && header != NULL) {
        snprintf(out, cap, "img-%08" PRIx32, header->crc32);
        return;
    }
    strlcpy(out, "none", cap);
}

static void publish_heartbeat(void)
{
    heartbeat_t beat = { 0 };
    if (sys_storage_device_id(beat.device_id, sizeof(beat.device_id)) != ESP_OK) {
        return;
    }
    model_version(beat.model_version, sizeof(beat.model_version));
    const esp_app_desc_t *app = esp_app_get_description();
    strlcpy(beat.fw_version, app != NULL ? app->version : "", sizeof(beat.fw_version));
    beat.ts = sys_time_now_ms();
    beat.uptime_seconds = esp_timer_get_time() / 1000000;

    int rssi = 0;
    beat.has_rssi_dbm = net_wifi_rssi_dbm(&rssi) == ESP_OK;
    beat.rssi_dbm = rssi;
    beat.heap_free_bytes = (int64_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    beat.heap_min_free_bytes = (int64_t)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL);
    beat.psram_free_bytes = (int64_t)heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    beat.has_heap_free_bytes = true;
    beat.has_heap_min_free_bytes = true;
    beat.has_psram_free_bytes = true;
    uint32_t pending = 0;
    beat.has_pending_uplink_count = sys_storage_attend_pending(&pending) == ESP_OK;
    beat.pending_uplink_count = pending;
    uint32_t slot = 0;
    beat.has_active_slot = sys_storage_get_u32(STORAGE_NS_MODEL, NVS_ACTIVE_SLOT, &slot) == ESP_OK;
    beat.active_slot = (uint8_t)slot;
    beat.boot_count = sys_storage_boot_count();
    beat.has_boot_count = true;
    beat.roster_version = roster_version();
    beat.has_roster_version = true;
    embedding_version(beat.embedding_version, sizeof(beat.embedding_version));
    beat.has_embedding_version = true;

    cJSON *root = heartbeat_to_json(&beat);
    if (root == NULL) {
        return;
    }
    char payload[HEARTBEAT_PAYLOAD_CAP];
    const bool printed = cJSON_PrintPreallocated(root, payload, sizeof(payload), 0);
    cJSON_Delete(root);
    if (!printed) {
        ESP_LOGW(TAG, "heartbeat will not fit %d B", HEARTBEAT_PAYLOAD_CAP);
        return;
    }
    // QoS 0 carries no ack, so this returns as soon as the packet is queued.
    net_mqtt_publish(GEN_TOPIC_HEARTBEAT, payload, strlen(payload), 0);
}

static void send_event(const app_event_t *from, const char *cmd_id)
{
    device_event_t event = { 0 };
    if (sys_storage_device_id(event.device_id, sizeof(event.device_id)) != ESP_OK) {
        return;
    }
    event.ts = sys_time_now_ms();
    event.type = (device_event_type_t)from->type;
    event.severity = (device_event_severity_t)from->severity;
    if (cmd_id != NULL && cmd_id[0] != '\0') {
        strlcpy(event.cmd_id, cmd_id, sizeof(event.cmd_id));
        event.has_cmd_id = true;
    }
    if (from->note[0] != '\0') {
        strlcpy(event.message, from->note, sizeof(event.message));
        event.has_message = true;
    }
    event.employee_id = from->employee_id;
    event.has_employee_id = from->has_employee;
    event.error_code = from->error_code;
    event.has_error_code = from->has_error;
    event.liveness_score = from->liveness;
    event.has_liveness_score = from->has_liveness;
    cJSON *root = device_event_to_json(&event);
    if (root == NULL) {
        return;
    }
    char payload[EVENT_PAYLOAD_CAP];
    const bool printed = cJSON_PrintPreallocated(root, payload, sizeof(payload), 0);
    cJSON_Delete(root);
    if (printed) {
        net_mqtt_publish(GEN_TOPIC_EVENT, payload, strlen(payload), CONFIG_SYNC_ACK_TIMEOUT_MS);
    }
}

static void publish_event(device_event_type_t type, device_event_severity_t severity,
                          const char *cmd_id, const char *message)
{
    app_event_t event = { 0 };
    event.type = type;
    event.severity = severity;
    if (message != NULL) {
        strlcpy(event.note, message, sizeof(event.note));
    }
    send_event(&event, cmd_id);
}

// The server owns identity, so a face captured here has to reach it or the
// person exists on one machine and nowhere else (KEHOACH 7.5).
static void report_enrolled(const app_roster_t *op)
{
    // One caller, and 900 bytes of base64 has no business on a 5 KB stack.
    static char payload[ENROLL_REPORT_CAP];
    enroll_payload_t wire = { 0 };
    wire.op = ENROLL_PAYLOAD_OP_UPSERT;
    wire.employee_id = op->employee_id;
    wire.template_idx = op->template_idx;
    wire.updated_at = sys_time_now_ms();
    wire.scale = op->scale;
    wire.quality = op->quality;
    wire.has_quality = true;
    if (sys_storage_device_id(wire.device_id, sizeof(wire.device_id)) == ESP_OK) {
        wire.has_device_id = true;
    }
    strlcpy(wire.full_name, op->name, sizeof(wire.full_name));
    wire.has_full_name = true;
    embedding_version(wire.embedding_version, sizeof(wire.embedding_version));
    size_t wrote = 0;
    if (mbedtls_base64_encode((unsigned char *)wire.embedding, sizeof(wire.embedding), &wrote,
                              (const unsigned char *)op->embedding,
                              sizeof(op->embedding)) != 0) {
        return;
    }
    cJSON *root = enroll_payload_to_json(&wire);
    if (root == NULL) {
        return;
    }
    const bool printed = cJSON_PrintPreallocated(root, payload, sizeof(payload), 0);
    cJSON_Delete(root);
    if (!printed) {
        ESP_LOGW(TAG, "enrol report will not fit %d B", ENROLL_REPORT_CAP);
        return;
    }
    const esp_err_t sent = net_mqtt_publish(GEN_TOPIC_ENROLL_REPORT, payload, strlen(payload),
                                            CONFIG_SYNC_ACK_TIMEOUT_MS);
    ESP_LOGI(TAG, "reported %" PRIu32 " sample %u: %s", op->employee_id,
             (unsigned)op->template_idx, esp_err_to_name(sent));
}

static ui_kiosk_pending_t s_pending[UI_KIOSK_PENDING_ROWS];
static int s_pending_count;
static _Atomic uint8_t s_brightness = 100;

static void offer_pending(void)
{
    ui_kiosk_set_pending(s_pending, s_pending_count);
}

static bool assign_pending(const app_roster_t *op)
{
    for (int i = 0; i < s_pending_count; ++i) {
        if (s_pending[i].employee_id == op->employee_id) {
            strlcpy(s_pending[i].name, op->name, sizeof(s_pending[i].name));
            offer_pending();
            return true;
        }
    }
    if (s_pending_count >= UI_KIOSK_PENDING_ROWS) {
        return false;
    }
    s_pending[s_pending_count].employee_id = op->employee_id;
    strlcpy(s_pending[s_pending_count].name, op->name, sizeof(s_pending[0].name));
    ++s_pending_count;
    offer_pending();
    return true;
}

static void revoke_pending(uint32_t employee_id)
{
    for (int i = 0; i < s_pending_count; ++i) {
        if (s_pending[i].employee_id != employee_id) {
            continue;
        }
        s_pending[i] = s_pending[s_pending_count - 1];
        --s_pending_count;
        offer_pending();
        return;
    }
}

static void revoke_all_pending(void)
{
    s_pending_count = 0;
    offer_pending();
}

// The cursor is written after the table, so a power cut costs one push again
// rather than a device claiming a version it never applied (KEHOACH 7.5).
static bool apply_roster(const app_roster_t *op)
{
    esp_err_t done = ESP_ERR_NOT_SUPPORTED;
    const char *refusal = NULL;
    switch (op->op) {
    case ENROLL_PAYLOAD_OP_UPSERT:
        done = svc_facedb_enroll(op->employee_id, op->template_idx, op->quality, op->embedding,
                                 op->scale, op->name);
        break;
    case ENROLL_PAYLOAD_OP_DELETE_EMPLOYEE:
        done = svc_facedb_remove(op->employee_id);
        break;
    case ENROLL_PAYLOAD_OP_ASSIGN:
        done = assign_pending(op) ? ESP_OK : ESP_ERR_NO_MEM;
        break;
    case ENROLL_PAYLOAD_OP_REVOKE:
        revoke_pending(op->employee_id);
        done = ESP_OK;
        break;
    case ENROLL_PAYLOAD_OP_DELETE:
        done = svc_facedb_remove_template(op->employee_id, op->template_idx);
        break;
    case ENROLL_PAYLOAD_OP_REPLACE_ALL:
        // The upserts that refill the table follow this one, and the kiosk
        // matches nobody until they land (KEHOACH 7.5).
        revoke_all_pending();
        done = svc_facedb_clear();
        break;
    default: refusal = "unknown roster op"; break;
    }
    if (refusal != NULL) {
        app_event_t event = { 0 };
        event.type = DEVICE_EVENT_TYPE_ROSTER_REJECTED;
        event.severity = DEVICE_EVENT_SEVERITY_WARN;
        event.employee_id = op->employee_id;
        event.has_employee = true;
        strlcpy(event.note, refusal, sizeof(event.note));
        note_event(&event);
        return false;
    }
    if (done != ESP_OK) {
        app_event_t event = { 0 };
        event.type = DEVICE_EVENT_TYPE_ROSTER_REJECTED;
        event.severity = DEVICE_EVENT_SEVERITY_ERROR;
        event.employee_id = op->employee_id;
        event.has_employee = true;
        event.error_code = (int32_t)done;
        event.has_error = true;
        strlcpy(event.note, esp_err_to_name(done), sizeof(event.note));
        note_event(&event);
        return false;
    }
    ESP_LOGI(TAG, "roster %s employee %" PRIu32,
             enroll_payload_op_str((enroll_payload_op_t)op->op), op->employee_id);
    return true;
}

// Delivery is at least once, so a push repeating or predating the version in
// hand writes an older face over a newer one (KEHOACH 9.23 rule 7).
static bool roster_op_is_fresh(const app_roster_t *op, uint32_t held)
{
    // REPLACE_ALL restates the roster, so it sets the count (KEHOACH 9.23).
    if (!op->has_roster_version || op->op == ENROLL_PAYLOAD_OP_REPLACE_ALL) {
        return true;
    }
    if (op->roster_version > held) {
        return true;
    }
    ESP_LOGW(TAG, "roster push at version %" PRIu32 " trails %" PRIu32 ", dropped",
             op->roster_version, held);
    return false;
}

// A kiosk joining a fleet takes the whole roster as a run of upserts, so the
// table is written once for the batch rather than once per person.
static void take_roster(const app_wiring_t *wiring)
{
    app_roster_t op;
    const uint32_t started_at = roster_version();
    uint32_t held = started_at;
    bool changed = false;
    while (xQueueReceive(wiring->roster, &op, 0) == pdTRUE) {
        if (op.outbound) {
            report_enrolled(&op);
            continue;
        }
        if (!roster_op_is_fresh(&op, held) || !apply_roster(&op)) {
            continue;
        }
        changed = changed || (op.op != ENROLL_PAYLOAD_OP_ASSIGN &&
                              op.op != ENROLL_PAYLOAD_OP_REVOKE);
        if (op.has_roster_version) {
            held = op.roster_version;
        }
    }
    if (changed) {
        const esp_err_t saved = svc_facedb_persist();
        if (saved != ESP_OK) {
            note_fault(DEVICE_EVENT_TYPE_STORAGE_FAULT, saved, "face table would not save");
            return;
        }
    }
    if (held != started_at) {
        sys_storage_set_u32(STORAGE_NS_DEVICE, NVS_ROSTER_VER, held);
        ESP_LOGI(TAG, "roster saved, now at version %" PRIu32, held);
    }
}

// Sweeping the channels blocks for seconds and drops the link while it runs,
// so it belongs on the lowest-priority task rather than the one that repaints.
static void take_wifi(void)
{
    if (ui_kiosk_take_wifi_scan()) {
        net_wifi_ap_t heard[UI_KIOSK_WIFI_ROWS];
        const size_t count = net_wifi_scan(heard, UI_KIOSK_WIFI_ROWS);
        // Two shapes on purpose: the screen has no business knowing the radio.
        ui_kiosk_ap_t shown[UI_KIOSK_WIFI_ROWS];
        char known[NET_WIFI_SSID_CAP] = { 0 };
        sys_storage_get_str(STORAGE_NS_WIFI, WIFI_NVS_SSID, known, sizeof(known));
        for (size_t i = 0; i < count; ++i) {
            strlcpy(shown[i].ssid, heard[i].ssid, sizeof(shown[i].ssid));
            shown[i].rssi_dbm = heard[i].rssi_dbm;
            shown[i].open = heard[i].open;
            shown[i].saved = known[0] != '\0' && strcmp(known, heard[i].ssid) == 0;
        }
        ui_kiosk_set_networks(shown, (int)count);
    }
    char ssid[NET_WIFI_SSID_CAP] = { 0 };
    char pass[NET_WIFI_PASS_CAP] = { 0 };
    bool stored = false;
    if (!ui_kiosk_take_wifi_join(ssid, sizeof(ssid), pass, sizeof(pass), &stored)) {
        return;
    }
    const esp_err_t joined = net_wifi_join(ssid, stored ? NULL : pass, WIFI_JOIN_WAIT_MS);
    ESP_LOGI(TAG, "join %s: %s", ssid, esp_err_to_name(joined));
    ui_kiosk_wifi_joined(joined);
}

// A kiosk has something to say at boot while the broker answers seconds later,
// so an event queues until the link is there to carry it.
static void take_events(const app_wiring_t *wiring)
{
    if (!net_mqtt_is_up()) {
        return;
    }
    app_event_t event;
    while (xQueueReceive(wiring->events, &event, 0) == pdTRUE) {
        send_event(&event, NULL);
    }
}

// A command the kiosk cannot run yet is refused by name: the server learns it
// arrived and why it stopped, which silence never tells it.
static const char *unsupported(device_command_action_t action)
{
    switch (action) {
    case DEVICE_COMMAND_ACTION_SET_CONFIG: return "SET_CONFIG has no config path yet";
    case DEVICE_COMMAND_ACTION_RELOAD_FACEDB: return "svc_facedb loads once at boot";
    case DEVICE_COMMAND_ACTION_CLEAR_LOGS: return "no log erase api yet";
    case DEVICE_COMMAND_ACTION_ROTATE_TOKEN: return "ticket rotation waits on E13-T5";
    case DEVICE_COMMAND_ACTION_SET_ACTIVE_SLOT: return "waits on model A/B, E13-T2";
    default: return NULL;
    }
}

static void run_command(const device_command_t *cmd, svc_door_t door)
{
    const char *refusal = unsupported(cmd->action);
    if (refusal != NULL) {
        publish_event(DEVICE_EVENT_TYPE_COMMAND_REJECTED, DEVICE_EVENT_SEVERITY_WARN,
                      cmd->cmd_id, refusal);
        return;
    }
    char note[64] = { 0 };
    esp_err_t done = ESP_OK;
    switch (cmd->action) {
    case DEVICE_COMMAND_ACTION_OPEN_DOOR: {
        const uint32_t hold_ms = cmd->has_open_ms ? (uint32_t)cmd->open_ms : OPEN_DOOR_DEFAULT_MS;
        done = svc_door_open(door, hold_ms);
        snprintf(note, sizeof(note), "door held %" PRIu32 " ms", hold_ms);
        break;
    }
    case DEVICE_COMMAND_ACTION_SYNC_TIME: {
        char host[SNTP_HOST_CAP] = { 0 };
        sntp_host(host, sizeof(host));
        done = sys_time_sync_start(host, on_time_synced, NULL);
        strlcpy(note, "sntp asked again", sizeof(note));
        break;
    }
    case DEVICE_COMMAND_ACTION_DIAGNOSTICS:
        publish_heartbeat();
        strlcpy(note, "heartbeat published", sizeof(note));
        break;
    case DEVICE_COMMAND_ACTION_REBOOT:
        publish_event(DEVICE_EVENT_TYPE_COMMAND_DONE, DEVICE_EVENT_SEVERITY_WARN, cmd->cmd_id,
                      "rebooting");
        // The result needs the radio, which esp_restart takes away.
        vTaskDelay(pdMS_TO_TICKS(REBOOT_DRAIN_MS));
        esp_restart();
        return;
    default:
        done = ESP_ERR_NOT_SUPPORTED;
        break;
    }
    if (done != ESP_OK) {
        snprintf(note, sizeof(note), "%s", esp_err_to_name(done));
    }
    publish_event(done == ESP_OK ? DEVICE_EVENT_TYPE_COMMAND_DONE
                                 : DEVICE_EVENT_TYPE_COMMAND_REJECTED,
                  done == ESP_OK ? DEVICE_EVENT_SEVERITY_INFO : DEVICE_EVENT_SEVERITY_ERROR,
                  cmd->cmd_id, note);
}

// QoS 1 may deliver the same command twice, so a repeat is ordinary traffic
// rather than an attack, and the second copy is simply not run again.
static bool already_ran(const char *cmd_id)
{
    static char seen[CMD_SEEN_RING][sizeof(((device_command_t *)0)->cmd_id)];
    static size_t at;
    for (size_t i = 0; i < CMD_SEEN_RING; ++i) {
        if (strcmp(seen[i], cmd_id) == 0) {
            return true;
        }
    }
    strlcpy(seen[at], cmd_id, sizeof(seen[at]));
    at = (at + 1) % CMD_SEEN_RING;
    return false;
}

static void take_commands(const app_wiring_t *wiring, svc_door_t door)
{
    device_command_t cmd;
    while (xQueueReceive(wiring->commands, &cmd, 0) == pdTRUE) {
        if (already_ran(cmd.cmd_id)) {
            ESP_LOGI(TAG, "command %s seen before, not run again", cmd.cmd_id);
            continue;
        }
        // A deadline means nothing on a clock no NTP has ever set.
        const bool clock_trusted = sys_time_source() == SYS_TIME_SOURCE_RTC_NTP;
        if (cmd.has_expires_at && clock_trusted && sys_time_now_ms() > cmd.expires_at) {
            publish_event(DEVICE_EVENT_TYPE_COMMAND_REJECTED, DEVICE_EVENT_SEVERITY_WARN,
                          cmd.cmd_id, "expired before it was read");
            continue;
        }
        ESP_LOGI(TAG, "command %s: %s", cmd.cmd_id, device_command_action_str(cmd.action));
        run_command(&cmd, door);
    }
}

// A fresh image is on trial until it signs for the slot, and "it booted" is too
// weak a claim: a broken model image boots fine and then recognises nobody.
static void settle_this_build(const app_wiring_t *wiring, int64_t up_ms)
{
    static bool signed_off;
    if (signed_off || !net_ota_on_trial() || up_ms < OTA_SETTLE_MS) {
        return;
    }
    if ((xEventGroupGetBits(wiring->flags) & APP_EG_AI_READY) == 0) {
        return;
    }
    signed_off = net_ota_mark_valid() == ESP_OK;
}

static void sync_task(void *arg)
{
    const app_wiring_t *wiring = arg;
    const esp_err_t ready = svc_sync_init();
    if (ready != ESP_OK) {
        ESP_LOGE(TAG, "uplink will not start: %s", esp_err_to_name(ready));
        vTaskDelete(NULL);
        return;
    }
    svc_door_t door = svc_door_servo();
    app_event_t booted = { 0 };
    booted.type = DEVICE_EVENT_TYPE_BOOTED;
    booted.severity = DEVICE_EVENT_SEVERITY_INFO;
    snprintf(booted.note, sizeof(booted.note), "boot %" PRIu32, sys_storage_boot_count());
    note_event(&booted);
    esp_err_t said = ESP_FAIL;
    uint32_t batches = 0;
    int64_t beat_ms = 0;
    int64_t drain_ms = 0;
    bool more = false;
    bool nudged = false;
    for (;;) {
        if (!more) {
            storage_attend_record_t nudge;
            // The short tick is for commands; the log is only read on the long
            // one, since a drain opens the cursor on flash every call.
            nudged = xQueueReceive(wiring->uplink, &nudge, pdMS_TO_TICKS(SYNC_TICK_MS)) == pdTRUE;
        }
        settle_this_build(wiring, esp_timer_get_time() / 1000);
        take_wifi();
        take_commands(wiring, door);
        take_roster(wiring);
        take_events(wiring);
        const int64_t now_ms = esp_timer_get_time() / 1000;
        if (net_mqtt_is_up() && now_ms - beat_ms >= GEN_TOPIC_HEARTBEAT_INTERVAL_S * 1000) {
            beat_ms = now_ms;
            publish_heartbeat();
        }
        if (!more && !nudged && now_ms - drain_ms < SYNC_POLL_MS) {
            continue;
        }
        drain_ms = now_ms;
        const esp_err_t drained = svc_sync_drain();
        more = drained == ESP_ERR_NOT_FINISHED;
        if (drained != ESP_OK && !more && drained != ESP_ERR_INVALID_STATE &&
            drained != ESP_ERR_TIMEOUT) {
            note_fault(DEVICE_EVENT_TYPE_STORAGE_FAULT, drained, "attendance log unreadable");
        }
        // A backlog is when progress is worth watching, so a long drain says
        // where it has got to rather than only speaking once it ends.
        if (drained != said || ++batches % SYNC_REPORT_BATCHES == 0) {
            said = drained;
            const svc_sync_stats_t stats = svc_sync_stats();
            ESP_LOGI(TAG, "uplink %s: %" PRIu32 " acked, %" PRIu32 " stalled, %" PRIu32 " resent",
                     esp_err_to_name(drained), stats.acked, stats.stalled, stats.orphans);
        }
        // The log lock has to be free between batches or attend_task waits.
        vTaskDelay(1);
    }
}

// Depth 1 and the newest frame wins, so the frame it displaces has to be handed
// back here or it never returns to the pool (KEHOACH 5.3).
static void offer_to_ai(QueueHandle_t frames, camera_fb_t *frame)
{
    camera_fb_t *displaced = NULL;
    if (xQueueReceive(frames, &displaced, 0) == pdTRUE) {
        drv_camera_release(displaced);
    }
    if (xQueueSend(frames, &frame, 0) != pdTRUE) {
        drv_camera_release(frame);
    }
}

// A screen that covers the panel has nothing new to say on most frames, and
// repainting it anyway costs the same gather a live preview does.
static esp_err_t show(const drv_lcd_overlay_t *overlay, const camera_fb_t *frame,
                      uint32_t *drawn_serial)
{
    if (overlay == NULL) {
        return drv_lcd_blit_frame(frame->buf, frame->width, frame->height, NULL);
    }
    if (!overlay->opaque) {
        *drawn_serial = 0;
        const esp_err_t drawn =
            drv_lcd_blit_frame(frame->buf, frame->width, frame->height, overlay);
        ui_kiosk_shown(overlay->serial);
        return drawn;
    }
    if (overlay->serial == *drawn_serial) {
        return ESP_OK;
    }
    const esp_err_t drawn = drv_lcd_paint(overlay, ui_kiosk_ground_rgb565());
    *drawn_serial = overlay->serial;
    ui_kiosk_shown(overlay->serial);
    return drawn;
}

static void cam_task(void *arg)
{
    const app_wiring_t *wiring = arg;
    int64_t window_started = esp_timer_get_time();
    int frames = 0;
    uint32_t drawn_serial = 0;
    esp_err_t last_blit = ESP_OK;
    bool resting = false;
    bool relight = false;

    for (;;) {
        const drv_lcd_overlay_t *overlay = ui_kiosk_hold();
        const bool wanted = rest_level() == REST_ALL;
        if (wanted != resting) {
            resting = wanted;
            if (resting) {
                drv_lcd_backlight(SCREEN_DIM_PERCENT);
                drv_lcd_sleep(true);
                drv_camera_rest(true);
            } else {
                drv_camera_rest(false);
                drv_lcd_sleep(false);
                drawn_serial = 0;
                // Panel memory still holds the old scene, so the lamp waits.
                relight = true;
                // The rate window spans the whole nap otherwise, and prints a
                // frame rate the kiosk never ran at.
                window_started = esp_timer_get_time();
                frames = 0;
            }
            ESP_LOGI(TAG, "panel and sensor %s, %lld ms since %s", resting ? "asleep" : "awake",
                     (long long)asleep_for_ms(), atomic_load(&s_awake_by));
        }
        if (resting) {
            ui_kiosk_release();
            vTaskDelay(pdMS_TO_TICKS(REST_POLL_MS));
            continue;
        }
        // A covering screen has no video to wait for, so it is drawn on publish (KEHOACH 4.5.5h).
        if (overlay != NULL && overlay->opaque) {
            const esp_err_t painted = show(overlay, NULL, &drawn_serial);
            ui_kiosk_release();
            if (painted != last_blit) {
                ESP_LOGE(TAG, "paint %s", esp_err_to_name(painted));
                last_blit = painted;
            }
            if (ui_kiosk_wait_publish(COVER_WAIT_MS)) {
                continue;
            }
            overlay = ui_kiosk_hold();
        }
        camera_fb_t *frame = drv_camera_grab();
        if (frame == NULL) {
            ui_kiosk_release();
            // Spinning here at this priority would starve the idle task and
            // trip the watchdog, so a dry pool costs one tick, not the core.
            vTaskDelay(1);
            continue;
        }
        drv_camera_expose(frame);
        const esp_err_t err = show(overlay, frame, &drawn_serial);
        ui_kiosk_release();
        offer_to_ai(wiring->frames, frame);
        if (relight && err == ESP_OK) {
            relight = false;
            drv_lcd_backlight(atomic_load(&s_brightness));
        }
        if (err != last_blit) {
            ESP_LOGE(TAG, "blit %s", esp_err_to_name(err));
            last_blit = err;
        }
        if (++frames >= RATE_WINDOW_FRAMES) {
            report_rate(frames, esp_timer_get_time() - window_started);
            window_started = esp_timer_get_time();
            frames = 0;
        }
    }
}

// Only svc_vision knows which gate a face failed, and a screen that guesses will
// claim work the pipeline is not doing (KEHOACH 4.5.5h.1).
static ui_kiosk_stage_t stage_of(svc_vision_kind_t kind)
{
    switch (kind) {
        case SVC_VISION_NO_FACE:
            return UI_KIOSK_STAGE_NO_FACE;
        case SVC_VISION_FACE_SMALL:
            return UI_KIOSK_STAGE_TOO_FAR;
        case SVC_VISION_FACE_OUT_OF_FRAME:
            return UI_KIOSK_STAGE_TOO_CLOSE;
        case SVC_VISION_FACE_OFF_GUIDE:
            return UI_KIOSK_STAGE_OFF_GUIDE;
        case SVC_VISION_FACE_SETTLED:
            return UI_KIOSK_STAGE_SETTLED;
        default:
            return UI_KIOSK_STAGE_WORKING;
    }
}

// svc_vision calls this the moment detect has run, which is what keeps the box
// on the glass half a second fresher than the whole step (KEHOACH 4.5.5d).
static void on_seen(const svc_vision_box_t *boxes, uint8_t count, uint32_t track,
                    svc_vision_kind_t stage, void *ctx)
{
    (void)ctx;
    ui_kiosk_on_faces(&boxes[0].box[0], count, s_seen_width, s_seen_height,
                      count > 0 ? boxes[0].yaw : 0.0f, track);
    ui_kiosk_on_stage(stage_of(stage));
}

static void ai_task(void *arg)
{
    const app_wiring_t *wiring = arg;
    svc_vision_on_seen(on_seen, NULL);
    const esp_err_t watched = esp_task_wdt_add(NULL);
    ESP_LOGI(TAG, "ai on core %d, watchdog %s", AI_TASK_CORE, esp_err_to_name(watched));
    bool had_face = false;
    bool working = true;

    for (;;) {
        if (rest_level() == REST_ALL) {
            esp_task_wdt_reset();
            camera_fb_t *stale = NULL;
            // Holding one of four buffers for a minute starves the sensor.
            while (xQueueReceive(wiring->frames, &stale, 0) == pdTRUE) {
                drv_camera_release(stale);
            }
            if (working) {
                working = false;
                had_face = false;
                s_seen_width = 0;
                ui_kiosk_on_faces(NULL, 0, 0, 0, 0.0f, 0);
                ui_kiosk_on_stage(UI_KIOSK_STAGE_NO_FACE);
                ESP_LOGI(TAG, "models asleep, %lld ms since %s", (long long)asleep_for_ms(),
                         atomic_load(&s_awake_by));
            }
            vTaskDelay(pdMS_TO_TICKS(REST_POLL_MS));
            continue;
        }
        if (!working) {
            working = true;
            ESP_LOGI(TAG, "models awake");
        }
        camera_fb_t *frame = NULL;
        // A dry queue is the camera's fault, so feeding the watchdog here keeps
        // the panic pointed at the task that stopped (KEHOACH 5.1).
        if (xQueueReceive(wiring->frames, &frame, pdMS_TO_TICKS(FRAME_WAIT_MS)) != pdTRUE) {
            esp_task_wdt_reset();
            ESP_LOGE(TAG, "no frame in %d ms", FRAME_WAIT_MS);
            note_fault(DEVICE_EVENT_TYPE_CAMERA_FAULT, ESP_ERR_TIMEOUT, "no frame from the sensor");
            continue;
        }
        svc_vision_result_t result = { 0 };
        s_seen_width = frame->width;
        s_seen_height = frame->height;
        const esp_err_t err = svc_vision_step(frame, &result);
        if ((result.faces > 0) != had_face) {
            had_face = result.faces > 0;
            ESP_LOGI(TAG, "face %s, %u seen", had_face ? "in" : "out", (unsigned)result.faces);
        }
        drv_camera_release(frame);
        esp_task_wdt_reset();
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "vision step %s", esp_err_to_name(err));
        } else if (result.kind != SVC_VISION_NONE) {
            ESP_LOGI(TAG, "verdict %d, face %d px yaw %+.2f, live %.3f, match %.3f, id %u",
                     (int)result.kind,
                     (int)(result.primary.box[2] - result.primary.box[0]), result.primary.yaw,
                     result.live_score, result.match_score, (unsigned)result.employee_id);
            if (ui_kiosk_enrolling()) {
                // Enrolling keeps attendance out of it, but a refused sample still
                // has to reach the glass or the screen waits mute (KEHOACH 4.5.5h.2).
                if (result.kind == SVC_VISION_SPOOF) {
                    ui_kiosk_enrol_refused();
                }
            // A dropped MATCH is an attendance nobody ever records (KEHOACH 5.3).
            } else {
                note_verdict(&result);
                if (xQueueSend(wiring->results, &result, pdMS_TO_TICKS(RESULT_WAIT_MS)) != pdTRUE) {
                    ESP_LOGE(TAG, "result %d dropped, attend queue full", (int)result.kind);
                }
            }
        }
        // Only IDLE1 feeds its own watchdog slot, so it needs a turn (KEHOACH 5.1).
        vTaskDelay(1);
    }
}

// One button until the enrol screen of E10-T7 lands; ui_kiosk owns where it
// sits and this task only says where the finger went.
static void touch_task(void *arg)
{
    (void)arg;
    bool held = false;
    for (;;) {
        // A held finger is read on a clock, so a lift the controller never flags still lands.
        if (held) {
            vTaskDelay(pdMS_TO_TICKS(TOUCH_POLL_MS));
        } else {
            drv_touch_wait(TOUCH_IDLE_WAIT_MS);
        }
        drv_touch_point_t points[TOUCH_POINTS];
        uint8_t count = 0;
        // A failed read says nothing about the finger: reporting a lift types a key twice.
        if (drv_touch_read(points, TOUCH_POINTS, &count) != ESP_OK) {
            continue;
        }
        held = count > 0;
        if (!held) {
            ui_kiosk_on_touch(false, 0, 0);
            continue;
        }
        stay_awake("touch");
        ui_kiosk_on_touch(true, points[0].x, points[0].y);
    }
}

// Main is the one layer that can see all of these, and none of them costs a
// flash read, so the page stays cheap to refresh (KEHOACH 4.5.5h.4).
static void say(ui_kiosk_fact_t *fact, ui_kiosk_fact_kind_t kind, const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    fact->kind = kind;
    vsnprintf(fact->value, sizeof(fact->value), fmt, args);
    va_end(args);
}

static void show_facts(void)
{
    ui_kiosk_fact_t fact[UI_KIOSK_FACTS];
    const esp_app_desc_t *app = esp_app_get_description();
    char device_id[STORAGE_DEVICE_ID_CAP] = { 0 };
    sys_storage_device_id(device_id, sizeof(device_id));
    int n = 0;
    say(&fact[n++], UI_KIOSK_FACT_VERSION, "%.20s", app != NULL ? app->version : "?");
    say(&fact[n++], UI_KIOSK_FACT_DEVICE_ID, "%s", device_id);
    say(&fact[n++], UI_KIOSK_FACT_ENROLLED, "%u", (unsigned)svc_facedb_count());
    say(&fact[n++], UI_KIOSK_FACT_RECORDS, "%" PRIu32, svc_attendance_records());
    say(&fact[n++], UI_KIOSK_FACT_WIFI_DROPS, "%" PRIu32, net_wifi_disconnects());
    say(&fact[n++], UI_KIOSK_FACT_WAKE_WITHIN, "%" PRIu32 " cm", atomic_load(&s_gate_mm) / 10);
    say(&fact[n++], UI_KIOSK_FACT_MIN_FACE, "%d px", svc_vision_face_min_px());
    say(&fact[n++], UI_KIOSK_FACT_RAM_FREE, "%u KB",
        (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT) / 1024));
    ui_kiosk_set_facts(fact, n);
}

static void show_net(void)
{
    ui_kiosk_net_t net = { 0 };
    net.joined = net_wifi_is_connected();
    if (net.joined) {
        net_wifi_ssid(net.ssid, sizeof(net.ssid));
        net_wifi_rssi_dbm(&net.rssi_dbm);
    }
    ui_kiosk_set_net(&net);
}

// The lamp and the amplifier answer every touch so the operator sees what they
// are turning; NVS hears only the touch that ends the drag (KEHOACH 4.5.5h.4).
static void take_levels(void)
{
    ui_kiosk_level_t which = UI_KIOSK_LEVEL_BRIGHTNESS;
    uint8_t percent = 0;
    bool settled = false;
    while (ui_kiosk_take_level(&which, &percent, &settled)) {
        const bool lamp = which == UI_KIOSK_LEVEL_BRIGHTNESS;
        if (lamp) {
            atomic_store(&s_brightness, percent);
            drv_lcd_backlight(percent);
        } else {
            drv_audio_set_volume(percent);
        }
        if (settled) {
            sys_storage_set_u32(STORAGE_NS_UI, lamp ? UI_NVS_BRIGHTNESS : UI_NVS_VOLUME, percent);
        }
    }
}

// The picker runs on ui_task, so the one NVS write lands off the paint path.
static void take_language(void)
{
    const char *picked = NULL;
    if (ui_kiosk_take_language(&picked)) {
        sys_storage_set_str(STORAGE_NS_UI, UI_NVS_LANGUAGE, picked);
    }
}

static void show_people(void)
{
    svc_facedb_person_t table[UI_KIOSK_PEOPLE_ROWS];
    ui_kiosk_person_t rows[UI_KIOSK_PEOPLE_ROWS];
    const size_t found = svc_facedb_people(table, UI_KIOSK_PEOPLE_ROWS);
    for (size_t i = 0; i < found; ++i) {
        rows[i].employee_id = table[i].employee_id;
        rows[i].templates = table[i].templates;
        memcpy(rows[i].name, table[i].name, sizeof(rows[i].name));
    }
    ui_kiosk_set_people(rows, (int)found);
}

// Publishing at QoS 1 waits for an ack, and ui_task repaints every 20 ms, so
// the templates go out through the task that already talks to the broker.
static void offer_enrolled(const app_wiring_t *wiring, uint32_t employee_id,
                           const char *name)
{
    for (uint16_t idx = 0; idx < ENROL_SAMPLES; ++idx) {
        app_roster_t op = { 0 };
        op.outbound = true;
        op.op = ENROLL_PAYLOAD_OP_UPSERT;
        op.employee_id = employee_id;
        op.template_idx = idx;
        if (svc_facedb_template(employee_id, idx, op.embedding, sizeof(op.embedding), &op.scale,
                                &op.quality) != ESP_OK) {
            continue;
        }
        strlcpy(op.name, name, sizeof(op.name));
        if (xQueueSend(wiring->roster, &op, pdMS_TO_TICKS(ROSTER_OFFER_WAIT_MS)) != pdTRUE) {
            ESP_LOGW(TAG, "enrol report for sample %u dropped", (unsigned)idx);
        }
    }
}

// An image that fails silently is one nobody can account for, so the reason
// leaves the kiosk while the kiosk is still the one running.
static void ota_refused(const ota_manifest_t *offer, const char *why)
{
    app_event_t event = { 0 };
    event.type = DEVICE_EVENT_TYPE_OTA_FAILED;
    event.severity = DEVICE_EVENT_SEVERITY_ERROR;
    strlcpy(event.note, why, sizeof(event.note));
    note_event(&event);
    ESP_LOGE(TAG, "ota %s refused: %s", offer->release_id, why);
}

static ui_kiosk_ticket_t ticket_shown(net_provision_answer_t answer)
{
    switch (answer) {
    case NET_PROVISION_REFUSED: return UI_KIOSK_TICKET_REFUSED;
    case NET_PROVISION_DISABLED: return UI_KIOSK_TICKET_NO_TOKEN;
    default: return UI_KIOSK_TICKET_WAITING;
    }
}

// Blocks until a person approves the kiosk; attendance queues offline meanwhile (KEHOACH 7.3).
static void fetch_ticket(const app_wiring_t *wiring)
{
    char id[STORAGE_DEVICE_ID_CAP] = { 0 };
    sys_storage_device_id(id, sizeof(id));
    for (uint32_t attempt = 0;; ++attempt) {
        const net_provision_answer_t answer = net_provision_register(NULL);
        if (answer == NET_PROVISION_GRANTED) {
            break;
        }
        // Read after the ask: a spent code has just been replaced (KEHOACH 7.3).
        char claim[8] = { 0 };
        net_provision_claim(claim, sizeof(claim));
        ui_kiosk_set_ticket(ticket_shown(answer), id, claim);
        // Only a person or a new image fixes a refused batch, so those ask at the ceiling.
        const bool hopeless = answer == NET_PROVISION_REFUSED || answer == NET_PROVISION_DISABLED;
        vTaskDelay(pdMS_TO_TICKS(net_provision_wait_ms(hopeless ? UINT32_MAX : attempt,
                                                       esp_random())));
    }
    ESP_LOGI(TAG, "ticket collected, dialling the broker");
    ui_kiosk_set_ticket(UI_KIOSK_TICKET_HELD, NULL, "");
    xEventGroupClearBits(wiring->flags, APP_EG_NEED_TICKET);
    start_broker();
}

static void recheck_ticket(const app_wiring_t *wiring, int64_t *checked_ms)
{
    xEventGroupClearBits(wiring->flags, APP_EG_BROKER_REFUSED);
    const int64_t now_ms = esp_timer_get_time() / 1000;
    if (net_mqtt_login() != NET_MQTT_LOGIN_TICKET ||
        (*checked_ms != 0 && now_ms - *checked_ms < TICKET_RECHECK_MS)) {
        return;
    }
    *checked_ms = now_ms;
    net_mqtt_stop();
    if (net_provision_check() == NET_PROVISION_REFUSED) {
        ESP_LOGW(TAG, "api says the ticket is dead, registering again");
        net_provision_forget();
        xEventGroupSetBits(wiring->flags, APP_EG_NEED_TICKET);
        return;
    }
    start_broker();
}

// The broker link is dropped for every HTTPS exchange: a second TLS session does
// not fit beside it, and a firmware install ends in a reboot anyway (KEHOACH 5.2).
static void ota_task(void *arg)
{
    const app_wiring_t *wiring = arg;
    int64_t checked_ms = 0;
    for (;;) {
        const EventBits_t flags = xEventGroupGetBits(wiring->flags);
        if (flags & APP_EG_NEED_TICKET) {
            fetch_ticket(wiring);
            continue;
        }
        if (flags & APP_EG_BROKER_REFUSED) {
            recheck_ticket(wiring, &checked_ms);
        }
        ota_manifest_t offer;
        if (xQueueReceive(wiring->ota, &offer, pdMS_TO_TICKS(TICKET_POLL_MS)) != pdTRUE) {
            continue;
        }
        const bool models = offer.target == OTA_MANIFEST_TARGET_MODELS;
        if (!models && offer.target != OTA_MANIFEST_TARGET_FIRMWARE) {
            ota_refused(&offer, "ASSETS has no path yet");
            continue;
        }
        if (offer.has_min_fw_version && !fw_at_least(offer.min_fw_version)) {
            ota_refused(&offer, "this build is older than the image asks for");
            continue;
        }
        const net_ota_image_t image = {
            .url = offer.url,
            .sha256 = offer.sha256,
            .size_bytes = (size_t)offer.size_bytes,
        };
        char why[NET_OTA_WHY_CAP] = { 0 };
        // Vetted while the link is still up: a manifest refused on arithmetic
        // does not get to cost the broker connection.
        if (net_ota_check(&image, models, why, sizeof(why)) != ESP_OK) {
            ota_refused(&offer, why);
            continue;
        }
        ESP_LOGW(TAG, "ota %s: %s, %lld bytes", offer.release_id, offer.version,
                 (long long)offer.size_bytes);
        net_mqtt_stop();
        const esp_err_t took = models ? net_ota_models(&image, why, sizeof(why))
                                      : net_ota_firmware(&image, why, sizeof(why));
        if (took == ESP_OK && models) {
            // The slot only counts once a boot has read it (KEHOACH 6.2.1).
            sys_storage_set_u32(STORAGE_NS_SYS, NVS_LAST_OTA, OTA_MODELS_ON_TRIAL);
        }
        if (took != ESP_OK) {
            ESP_LOGE(TAG, "ota %s failed: %s (%s)", offer.release_id, why,
                     esp_err_to_name(took));
            // The link comes back so the failure can be reported at all.
            start_broker();
            ota_refused(&offer, why);
            continue;
        }
        ESP_LOGW(TAG, "ota %s armed, rebooting into it", offer.release_id);
        vTaskDelay(pdMS_TO_TICKS(OTA_REBOOT_WAIT_MS));
        esp_restart();
    }
}

// The screens ask for a face and svc_vision answers with the next one it
// embeds, so the enrol flow needs no camera path of its own (KEHOACH 4.5.5h).
static void ui_task(void *arg)
{
    const app_wiring_t *wiring = arg;
    bool armed = false;
    bool enrolling = false;
    uint32_t new_employee = 0;
    char new_name[STORAGE_NAME_CAP] = { 0 };

    for (;;) {
        const uint32_t tick_ms =
            rest_level() == REST_ALL ? UI_REST_TICK_MS : UI_TICK_MS;
        vTaskDelay(pdMS_TO_TICKS(tick_ms));
        ui_kiosk_tick(tick_ms);
        const bool now_enrolling = ui_kiosk_enrolling();
        if (enrolling && !now_enrolling) {
            // The enrolled track has already matched, and a matched track is
            // never verified again (KEHOACH 4.5.5d).
            svc_vision_reset();
            // Leaving early must not keep a person nobody finished adding.
            if (new_employee != 0 && !ui_kiosk_enrol_complete() &&
                svc_facedb_remove(new_employee) == ESP_OK) {
                ESP_LOGW(TAG, "enrol %" PRIu32 " left unfinished, dropped: %s", new_employee,
                         esp_err_to_name(svc_facedb_persist()));
            }
            new_employee = 0;
            new_name[0] = '\0';
        }
        enrolling = now_enrolling;
        if (armed && !svc_vision_enrol_pending()) {
            armed = false;
            ui_kiosk_enrol_kept();
            if (ui_kiosk_enrol_complete()) {
                const int64_t started_us = esp_timer_get_time();
                const esp_err_t saved = svc_facedb_persist();
                ESP_LOGI(TAG, "enrol %" PRIu32 " saved in %lld ms: %s", new_employee,
                         (long long)((esp_timer_get_time() - started_us) / 1000),
                         esp_err_to_name(saved));
                if (saved == ESP_OK) {
                    offer_enrolled(wiring, new_employee, new_name);
                }
            }
        }
        // Coming back from a menu is routine; a face outliving every verdict
        // it is owed means a model stopped answering.
        bool stuck = false;
        if (ui_kiosk_take_vision_reset(&stuck)) {
            svc_vision_reset();
            if (stuck) {
                ESP_LOGW(TAG, "vision restarted: a face outlived every verdict it is owed");
            }
        }
        take_levels();
        take_language();
        if (ui_kiosk_take_people_request()) {
            show_people();
        }
        if (ui_kiosk_take_pending_request()) {
            offer_pending();
        }
        uint32_t going = 0;
        if (ui_kiosk_take_remove(&going)) {
            const esp_err_t gone = svc_facedb_remove(going);
            const esp_err_t saved = gone == ESP_OK ? svc_facedb_persist() : gone;
            ESP_LOGI(TAG, "remove %" PRIu32 ": %s, saved %s", going, esp_err_to_name(gone),
                     esp_err_to_name(saved));
            show_people();
        }
        uint32_t employee_id = 0;
        uint16_t template_idx = 0;
        char name[STORAGE_NAME_CAP] = { 0 };
        float yaw_min = 0.0f;
        float yaw_max = 0.0f;
        if (!ui_kiosk_take_enrol(&employee_id, &template_idx, name, sizeof(name), &yaw_min,
                                 &yaw_max)) {
            continue;
        }
        svc_attendance_policy_t policy = { 0 };
        // A template taken with no liveness answer is a spoof wearing a name, and
        // the bit that already governs the door answers this too (KEHOACH 4.5.5h.2).
        if (ai_engine_spoof_input_bytes() == 0 &&
            (svc_attendance_policy(&policy) != ESP_OK || !policy.allow_no_spoof)) {
            ESP_LOGE(TAG, "enrol refused for %s: no spoof branch and the policy forbids it", name);
            continue;
        }
        // The id is the one the server assigned; a kiosk mints none (KEHOACH 7.5).
        if (employee_id == 0) {
            ESP_LOGE(TAG, "enrol refused for %s: the server assigned no id", name);
            continue;
        }
        new_employee = employee_id;
        strlcpy(new_name, name, sizeof(new_name));
        const esp_err_t asked =
            svc_vision_enrol_next(employee_id, template_idx, name, yaw_min, yaw_max);
        armed = asked == ESP_OK;
        ESP_LOGI(TAG, "enrol %u sample %u for %s: %s", (unsigned)employee_id,
                 (unsigned)template_idx, name, esp_err_to_name(asked));
    }
}

// The clip is read once and kept: a grant must not wait on a file, and the
// header is walked rather than assumed because a wav carries optional chunks.
static size_t pcm_of(const uint8_t *wav, size_t len, const int16_t **pcm)
{
    if (len < WAV_HEADER_MIN || memcmp(wav, "RIFF", 4) != 0 || memcmp(wav + 8, "WAVE", 4) != 0) {
        return 0;
    }
    size_t at = 12;
    while (at + 8 <= len) {
        uint32_t size = 0;
        memcpy(&size, wav + at + 4, sizeof(size));
        const uint8_t *body = wav + at + 8;
        if (memcmp(wav + at, "data", 4) == 0) {
            const size_t have = len - (at + 8);
            *pcm = (const int16_t *)body;
            return (size < have ? size : have) / sizeof(int16_t);
        }
        at += 8 + size + (size & 1u);
    }
    return 0;
}

static void audio_task(void *arg)
{
    const app_wiring_t *wiring = arg;
    uint8_t *clip = heap_caps_malloc(AUDIO_CLIP_CAP_BYTES, MALLOC_CAP_SPIRAM);
    const int16_t *pcm = NULL;
    size_t samples = 0;
    size_t len = 0;
    if (clip != NULL && sys_storage_read(AUDIO_CLIP_PATH, clip, AUDIO_CLIP_CAP_BYTES, &len) ==
                            ESP_OK) {
        samples = pcm_of(clip, len, &pcm);
    }
    ESP_LOGI(TAG, "audio: %s, %u samples", samples > 0 ? AUDIO_CLIP_PATH : "no clip",
             (unsigned)samples);

    for (;;) {
        app_sound_t sound = APP_SOUND_OK;
        if (xQueueReceive(wiring->sounds, &sound, portMAX_DELAY) != pdTRUE) {
            continue;
        }
        if (sound != APP_SOUND_OK || samples == 0) {
            continue;
        }
        const esp_err_t played = drv_audio_play_pcm(pcm, samples);
        if (played != ESP_OK) {
            ESP_LOGE(TAG, "audio play %s", esp_err_to_name(played));
        }
    }
}

static uint32_t presence_gate_mm(void)
{
    uint32_t gate_mm = 0;
    const esp_err_t stored = sys_storage_get_u32(STORAGE_NS_VISION, NVS_PRESENT_MM, &gate_mm);
    if (stored != ESP_OK || gate_mm == 0) {
        gate_mm = CONFIG_VISION_SEED_PRESENT_MM;
        ESP_LOGW(TAG, "no presence gate in nvs, seeding %" PRIu32 " mm", gate_mm);
    }
    return gate_mm;
}

static void tof_task(void *arg)
{
    const app_wiring_t *wiring = arg;
    SemaphoreHandle_t ready = drv_tof_ready_signal();
    const uint32_t gate_mm = presence_gate_mm();
    atomic_store(&s_gate_mm, gate_mm);
    bool present = false;
    int settling = TOF_SETTLE_POLLS;
    int away = PRESENCE_AWAY_SAMPLES;

    for (;;) {
        if (ready != NULL) {
            xSemaphoreTake(ready, pdMS_TO_TICKS(TOF_POLL_MS));
        } else {
            vTaskDelay(pdMS_TO_TICKS(TOF_POLL_MS));
        }
        uint16_t distance_mm = 0;
        bool status_ok = false;
        const esp_err_t ranged = drv_tof_read_mm(&distance_mm, &status_ok);
        if (ranged != ESP_OK) {
            // No sample yet is the normal gap between measurements; a broken
            // sensor is not, and it must not be what puts the kiosk to sleep.
            if (ranged != ESP_ERR_TIMEOUT) {
                stay_awake("tof broken");
                note_fault(DEVICE_EVENT_TYPE_TOF_FAULT, ranged, "range read failed");
            }
            continue;
        }
        // The first rangings carry nothing behind them: one read 59 mm into an
        // empty room (E7-T7).
        if (settling > 0) {
            --settling;
            continue;
        }
        // An empty field reads 65535 mm with the status clear (E7-T7), so a bad
        // status is nobody standing there rather than nothing to report.
        const uint32_t reading_mm = status_ok ? distance_mm : UINT16_MAX;
        const uint32_t edge_mm = present ? gate_mm + PRESENCE_HYSTERESIS_MM : gate_mm;
        // One bad range status is not an answer to whether somebody is standing
        // there, so absence has to hold for a run of samples (KEHOACH 5.4).
        if (reading_mm <= edge_mm) {
            away = 0;
        } else if (away < PRESENCE_AWAY_SAMPLES) {
            ++away;
        }
        const bool now = away < PRESENCE_AWAY_SAMPLES;
        if (now) {
            stay_awake("tof near");
        }
        if (now == present) {
            continue;
        }
        present = now;
        const app_presence_t edge = present ? APP_PRESENCE_ON : APP_PRESENCE_OFF;
        // A lost edge strands the machine in one state, so it cannot be silent.
        if (xQueueSend(wiring->presence, &edge, pdMS_TO_TICKS(PRESENCE_WAIT_MS)) != pdTRUE) {
            ESP_LOGE(TAG, "presence %s dropped, queue full", present ? "on" : "off");
        }
        if (present) {
            xEventGroupSetBits(wiring->flags, APP_EG_PRESENT);
        } else {
            xEventGroupClearBits(wiring->flags, APP_EG_PRESENT);
        }
        ESP_LOGI(TAG, "presence %s at %" PRIu32 " mm, gate %" PRIu32 " mm",
                 present ? "on" : "off", reading_mm, edge_mm);
    }
}

static app_ui_verdict_t refusal_of(svc_vision_kind_t kind)
{
    switch (kind) {
        case SVC_VISION_SPOOF:
            return APP_UI_SPOOF;
        case SVC_VISION_UNKNOWN:
            return APP_UI_UNKNOWN;
        // A match the liveness policy refused is the one refusal with no word of its own.
        default:
            return APP_UI_DENIED;
    }
}

// The kiosk speaks only when it opens the door: a refusal is already on the
// glass, and a sound would announce it to the room (KEHOACH 6.2.8).
static void announce(const app_wiring_t *wiring)
{
    const app_sound_t sound = APP_SOUND_OK;
    if (xQueueSend(wiring->sounds, &sound, pdMS_TO_TICKS(SOUND_WAIT_MS)) != pdTRUE) {
        ESP_LOGW(TAG, "grant sound dropped, audio queue full");
    }
}

// Every answer about a face reaches the glass, tagged with its track (KEHOACH 4.5.5h.1).
static void tell(const app_wiring_t *wiring, const svc_vision_result_t *result,
                 svc_attendance_said_t said)
{
    ui_kiosk_verdict_t shown = { .track = result->track };
    if (said == SVC_ATTENDANCE_SAID_REFUSED) {
        shown.verdict = refusal_of(result->kind);
    } else if (said == SVC_ATTENDANCE_SAID_GRANTED) {
        shown.verdict = APP_UI_GRANTED;
        shown.employee_id = result->employee_id;
        memcpy(shown.name, result->name, sizeof(shown.name));
    } else if (said == SVC_ATTENDANCE_SAID_ALREADY) {
        // Quiet on purpose, but the green guide has to follow the new track (KEHOACH 4.5.5f).
        shown.verdict = APP_UI_ALREADY;
    } else {
        return;
    }
    ESP_LOGI(TAG, "told track %" PRIu32 " verdict %d on vision %d, employee %" PRIu32,
             result->track, (int)shown.verdict, (int)result->kind, result->employee_id);
    ui_kiosk_on_verdict(&shown);
    if (said == SVC_ATTENDANCE_SAID_GRANTED) {
        announce(wiring);
    }
}

// A full queue costs a resend at most, since flash already holds every record
// that reaches here (KEHOACH 5.3, 6.2.6).
static void offer_uplink(const app_wiring_t *wiring)
{
    static bool said_full;
    storage_attend_record_t record;
    if (svc_attendance_last_record(&record) != ESP_OK) {
        return;
    }
    const bool sent = xQueueSend(wiring->uplink, &record, 0) == pdTRUE;
    if (!sent && !said_full) {
        ESP_LOGW(TAG, "uplink queue full from record %" PRIu32 " on, flash keeps them",
                 svc_attendance_records());
    }
    said_full = !sent;
}

static void attend_task(void *arg)
{
    const app_wiring_t *wiring = arg;
    svc_attendance_state_t last_state = svc_attendance_state();
    uint32_t records = svc_attendance_records();

    for (;;) {
        app_presence_t edge = APP_PRESENCE_OFF;
        while (xQueueReceive(wiring->presence, &edge, 0) == pdTRUE) {
            svc_attendance_on_presence(edge == APP_PRESENCE_ON);
        }
        svc_vision_result_t result;
        if (xQueueReceive(wiring->results, &result, pdMS_TO_TICKS(ATTEND_TICK_MS)) == pdTRUE) {
            svc_attendance_said_t said = SVC_ATTENDANCE_SAID_NOTHING;
            svc_attendance_on_vision(&result, sys_time_now_ms(), &said);
            tell(wiring, &result, said);
        }
        svc_attendance_tick(sys_time_now_ms());

        {
            static int64_t settings_at_ms;
            // Nobody can read a sleeping panel, and the page walks the heap.
            const bool readable = rest_level() != REST_ALL;
            if (readable && sys_time_now_ms() - settings_at_ms > SETTINGS_REFRESH_MS) {
                settings_at_ms = sys_time_now_ms();
                show_facts();
                show_net();
            }
        }
        const svc_attendance_state_t state = svc_attendance_state();
        if (state != last_state) {
            ESP_LOGI(TAG, "attendance state %d to %d", (int)last_state, (int)state);
            last_state = state;
            // Detecting is the machine taking up somebody new (KEHOACH 4.5.5h.1).
            if (state == SVC_ATTENDANCE_DETECTING) {
                const ui_kiosk_verdict_t scanning = { .verdict = APP_UI_SCANNING };
                ui_kiosk_on_verdict(&scanning);
            }
        }
        if (svc_attendance_records() != records) {
            records = svc_attendance_records();
            offer_uplink(wiring);
        }
    }
}

typedef struct {
    TaskFunction_t entry;
    const char *name;
    uint32_t stack_bytes;
    UBaseType_t priority;
    BaseType_t core;
    EventBits_t needs;
} app_task_spec_t;

static const app_task_spec_t kTasks[] = {
    { cam_task, "cam", CAM_TASK_STACK_BYTES, CAM_TASK_PRIORITY, CAM_TASK_CORE, 0 },
    { tof_task, "tof", TOF_TASK_STACK_BYTES, TOF_TASK_PRIORITY, TOF_TASK_CORE, 0 },
    { ai_task, "ai", AI_TASK_STACK_BYTES, AI_TASK_PRIORITY, AI_TASK_CORE, APP_EG_AI_READY },
    { touch_task, "touch", TOUCH_TASK_STACK_BYTES, TOUCH_TASK_PRIORITY, TOUCH_TASK_CORE, 0 },
    { ui_task, "ui", UI_TASK_STACK_BYTES, UI_TASK_PRIORITY, UI_TASK_CORE, 0 },
    { audio_task, "audio", AUDIO_TASK_STACK_BYTES, AUDIO_TASK_PRIORITY, AUDIO_TASK_CORE, 0 },
    { attend_task, "attend", ATTEND_TASK_STACK_BYTES, ATTEND_TASK_PRIORITY, ATTEND_TASK_CORE, 0 },
    { net_task, "net", NET_TASK_STACK_BYTES, NET_TASK_PRIORITY, NET_TASK_CORE, 0 },
    { sync_task, "sync", SYNC_TASK_STACK_BYTES, SYNC_TASK_PRIORITY, SYNC_TASK_CORE, 0 },
    { ota_task, "ota", OTA_TASK_STACK_BYTES, OTA_TASK_PRIORITY, OTA_TASK_CORE, 0 },
};

#define TASK_COUNT (sizeof(kTasks) / sizeof(kTasks[0]))

esp_err_t app_tasks_start(void)
{
    const app_wiring_t *wiring = app_wiring();
    if (wiring == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    stay_awake("boot");
    // Core 1 stays clear for ai_task, whose one Invoke holds a core for
    // 100-400 ms and would stall everything sharing it (KEHOACH 5.1).
    const EventBits_t up = xEventGroupGetBits(wiring->flags);
    for (size_t i = 0; i < TASK_COUNT; ++i) {
        const app_task_spec_t *spec = &kTasks[i];
        if ((up & spec->needs) != spec->needs) {
            ESP_LOGW(TAG, "%s stays down: flags %02X, needs %02X", spec->name, (unsigned)up,
                     (unsigned)spec->needs);
            continue;
        }
        const BaseType_t started = xTaskCreatePinnedToCore(
            spec->entry, spec->name, spec->stack_bytes, (void *)wiring, spec->priority, NULL,
            spec->core);
        if (started != pdPASS) {
            ESP_LOGE(TAG, "%s will not start", spec->name);
            return ESP_ERR_NO_MEM;
        }
    }
    return ESP_OK;
}
