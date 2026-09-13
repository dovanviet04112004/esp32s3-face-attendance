#include "app_tasks.h"

#include <inttypes.h>
#include <string.h>

#include "app_config.h"
#include "app_events.h"
#include "app_wiring.h"
#include "drv_camera.h"
#include "drv_lcd.h"
#include "drv_tof.h"
#include "drv_touch.h"
#include "esp_log.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "net_wifi.h"
#include "storage_format.h"
#include "svc_attendance.h"
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
static int s_face_min_px;

#define CAM_TASK_CORE 0
#define CAM_TASK_PRIORITY 7
#define CAM_TASK_STACK_BYTES 4096
#define RATE_WINDOW_FRAMES 60
#define TOF_TASK_CORE 0
#define TOF_TASK_PRIORITY 6
#define TOF_TASK_STACK_BYTES 3072
#define TOF_POLL_MS 100
#define PRESENCE_HYSTERESIS_MM 60
#define AI_TASK_CORE 1
#define AI_TASK_PRIORITY 5
#define AI_TASK_STACK_BYTES 8192
#define FRAME_WAIT_MS 2000
#define RESULT_WAIT_MS 100
#define ATTEND_TASK_CORE 0
#define ATTEND_TASK_PRIORITY 4
#define ATTEND_TASK_STACK_BYTES 4096
#define ATTEND_TICK_MS 200
#define NET_TASK_CORE 0
#define NET_TASK_PRIORITY 3
#define NET_TASK_STACK_BYTES 4096
#define JOIN_WAIT_MS 30000
#define SNTP_HOST_CAP 64
#define NVS_SNTP_HOST "sntp_host"
#define NVS_RTC_NTP_SET "rtc_ntp_set"
#define NVS_PRESENT_MM "present_mm"
#define NVS_ENROL_NAME "enrol_name"
#define ENROL_EMPLOYEE_ID 1u
#define TOUCH_TASK_CORE 0
#define TOUCH_TASK_PRIORITY 5
#define TOUCH_TASK_STACK_BYTES 3072
#define TOUCH_POLL_MS 40
#define TOUCH_POINTS 1
#define UI_TASK_CORE 0
#define UI_TASK_PRIORITY 4
#define UI_TASK_STACK_BYTES 8192
#define UI_TICK_MS 20
#define UI_GROUND_RGB565 0x0821

static void report_rate(int frames, int64_t elapsed_us)
{
    const int mfps = elapsed_us > 0 ? (int)((int64_t)frames * 1000000000 / elapsed_us) : 0;
    int level = 0, exposure = 0, gain16 = 0;
    drv_camera_exposure_state(&level, &exposure, &gain16);
    ESP_LOGI(TAG, "preview %d.%03d fps, level %d, exposure %d lines, gain %d/16", mfps / 1000,
             mfps % 1000, level, exposure, gain16);
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

// One shot: the clock needs a netif, so the wait belongs off app_main and the
// task leaves once the correction is under way.
static void net_task(void *arg)
{
    (void)arg;
    if (net_wifi_wait_connected(JOIN_WAIT_MS) != ESP_OK) {
        ESP_LOGW(TAG, "no link in %d ms, clock stays on the rtc", JOIN_WAIT_MS);
        vTaskDelete(NULL);
        return;
    }
    xEventGroupSetBits(app_wiring()->flags, APP_EG_WIFI_OK);
    char host[SNTP_HOST_CAP] = { 0 };
    const esp_err_t stored = sys_storage_get_str(STORAGE_NS_DEVICE, NVS_SNTP_HOST, host,
                                                 sizeof(host));
    if (stored != ESP_OK) {
        ESP_LOGW(TAG, "no sntp host in nvs: %s", esp_err_to_name(stored));
        vTaskDelete(NULL);
        return;
    }
    const esp_err_t sync = sys_time_sync_start(host, on_time_synced, NULL);
    ESP_LOGI(TAG, "sntp against %s: %s", host, esp_err_to_name(sync));
    vTaskDelete(NULL);
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
        return drv_lcd_blit_frame(frame->buf, frame->width, frame->height, overlay);
    }
    if (overlay->serial == *drawn_serial) {
        return ESP_OK;
    }
    *drawn_serial = overlay->serial;
    return drv_lcd_paint(overlay, UI_GROUND_RGB565);
}

static void cam_task(void *arg)
{
    const app_wiring_t *wiring = arg;
    int64_t window_started = esp_timer_get_time();
    int frames = 0;
    uint32_t drawn_serial = 0;
    esp_err_t last_blit = ESP_OK;

    for (;;) {
        camera_fb_t *frame = drv_camera_grab();
        if (frame == NULL) {
            // Spinning here at this priority would starve the idle task and
            // trip the watchdog, so a dry pool costs one tick, not the core.
            vTaskDelay(1);
            continue;
        }
        drv_camera_expose(frame);
        const esp_err_t err = show(ui_kiosk_overlay(), frame, &drawn_serial);
        offer_to_ai(wiring->frames, frame);
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

// svc_vision calls this the moment detect has run, which is what keeps the box
// on the glass half a second fresher than the whole step (KEHOACH 4.5.5d).
static void on_seen(const svc_vision_box_t *boxes, uint8_t count, void *ctx)
{
    (void)ctx;
    ui_kiosk_on_faces(&boxes[0].box[0], count, s_seen_width, s_seen_height, s_face_min_px);
}

static void ai_task(void *arg)
{
    const app_wiring_t *wiring = arg;
    s_face_min_px = svc_vision_face_min_px();
    svc_vision_on_seen(on_seen, NULL);
    const esp_err_t watched = esp_task_wdt_add(NULL);
    ESP_LOGI(TAG, "ai on core %d, watchdog %s", AI_TASK_CORE, esp_err_to_name(watched));
    bool had_face = false;

    for (;;) {
        camera_fb_t *frame = NULL;
        // A dry queue is the camera's fault, so feeding the watchdog here keeps
        // the panic pointed at the task that stopped (KEHOACH 5.1).
        if (xQueueReceive(wiring->frames, &frame, pdMS_TO_TICKS(FRAME_WAIT_MS)) != pdTRUE) {
            esp_task_wdt_reset();
            ESP_LOGE(TAG, "no frame in %d ms", FRAME_WAIT_MS);
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
            ESP_LOGI(TAG, "verdict %d, live %.3f, match %.3f, id %u", (int)result.kind,
                     result.live_score, result.match_score, (unsigned)result.employee_id);
            // A dropped MATCH is an attendance nobody ever records (KEHOACH 5.3).
            if (xQueueSend(wiring->results, &result, pdMS_TO_TICKS(RESULT_WAIT_MS)) != pdTRUE) {
                ESP_LOGE(TAG, "result %d dropped, attend queue full", (int)result.kind);
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
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(TOUCH_POLL_MS));
        drv_touch_point_t points[TOUCH_POINTS];
        uint8_t count = 0;
        if (drv_touch_read(points, TOUCH_POINTS, &count) != ESP_OK || count == 0) {
            ui_kiosk_on_touch(false, 0, 0);
            continue;
        }
        ui_kiosk_on_touch(true, points[0].x, points[0].y);
    }
}

// The screens ask for a face and svc_vision answers with the next one it
// embeds, so the enrol flow needs no camera path of its own (KEHOACH 4.5.5h).
static void ui_task(void *arg)
{
    (void)arg;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(UI_TICK_MS));
        ui_kiosk_tick(UI_TICK_MS);
        uint32_t employee_id = 0;
        uint16_t template_idx = 0;
        char name[STORAGE_NAME_CAP] = { 0 };
        if (!ui_kiosk_take_enrol(&employee_id, &template_idx, name, sizeof(name))) {
            continue;
        }
        const esp_err_t armed = svc_vision_enrol_next(employee_id, template_idx, name);
        ESP_LOGI(TAG, "enrol %u sample %u for %s: %s", (unsigned)employee_id,
                 (unsigned)template_idx, name, esp_err_to_name(armed));
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
    bool present = false;

    for (;;) {
        if (ready != NULL) {
            xSemaphoreTake(ready, pdMS_TO_TICKS(TOF_POLL_MS));
        } else {
            vTaskDelay(pdMS_TO_TICKS(TOF_POLL_MS));
        }
        uint16_t distance_mm = 0;
        bool status_ok = false;
        if (drv_tof_read_mm(&distance_mm, &status_ok) != ESP_OK) {
            continue;
        }
        // An empty field reads 65535 mm with the status clear (E7-T7), so a bad
        // status is nobody standing there rather than nothing to report.
        const uint32_t reading_mm = status_ok ? distance_mm : UINT16_MAX;
        const uint32_t edge_mm = present ? gate_mm + PRESENCE_HYSTERESIS_MM : gate_mm;
        const bool now = reading_mm <= edge_mm;
        if (now == present) {
            continue;
        }
        present = now;
        const app_presence_t edge = present ? APP_PRESENCE_ON : APP_PRESENCE_OFF;
        xQueueSend(wiring->presence, &edge, 0);
        if (present) {
            xEventGroupSetBits(wiring->flags, APP_EG_PRESENT);
        } else {
            xEventGroupClearBits(wiring->flags, APP_EG_PRESENT);
        }
        ESP_LOGI(TAG, "presence %s at %" PRIu32 " mm, gate %" PRIu32 " mm",
                 present ? "on" : "off", reading_mm, edge_mm);
    }
}

static app_sound_t sound_for(svc_attendance_state_t state, svc_vision_kind_t kind)
{
    if (state == SVC_ATTENDANCE_GRANTED) {
        return APP_SOUND_OK;
    }
    return kind == SVC_VISION_SPOOF ? APP_SOUND_SPOOF : APP_SOUND_DENIED;
}

static app_ui_verdict_t verdict_for(svc_attendance_state_t state, svc_vision_kind_t kind)
{
    switch (state) {
        case SVC_ATTENDANCE_DETECTING:
        case SVC_ATTENDANCE_VERIFYING:
            return APP_UI_SCANNING;
        case SVC_ATTENDANCE_GRANTED:
            return APP_UI_GRANTED;
        // Whatever the line says stays up through the rest that follows it.
        case SVC_ATTENDANCE_DENIED:
        case SVC_ATTENDANCE_COOLDOWN:
            if (kind == SVC_VISION_MATCH) {
                return APP_UI_GRANTED;
            }
            if (kind == SVC_VISION_SPOOF) {
                return APP_UI_SPOOF;
            }
            return kind == SVC_VISION_UNKNOWN ? APP_UI_UNKNOWN : APP_UI_DENIED;
        default:
            return APP_UI_IDLE;
    }
}

static void announce(const app_wiring_t *wiring, svc_attendance_state_t state,
                     svc_vision_kind_t kind)
{
    if (state != SVC_ATTENDANCE_GRANTED && state != SVC_ATTENDANCE_DENIED) {
        return;
    }
    const app_sound_t sound = sound_for(state, kind);
    xQueueSend(wiring->sounds, &sound, 0);
}

// A full queue costs a resend at most, since flash already holds every record
// that reaches here (KEHOACH 5.3, 6.2.6).
static void offer_uplink(const app_wiring_t *wiring)
{
    storage_attend_record_t record;
    if (svc_attendance_last_record(&record) != ESP_OK) {
        return;
    }
    if (xQueueSend(wiring->uplink, &record, 0) != pdTRUE) {
        ESP_LOGW(TAG, "uplink queue full, record %" PRIu32 " waits on flash",
                 svc_attendance_records());
    }
}

static void attend_task(void *arg)
{
    const app_wiring_t *wiring = arg;
    svc_attendance_state_t last_state = svc_attendance_state();
    svc_vision_kind_t last_kind = SVC_VISION_NONE;
    uint32_t last_employee = 0;
    char last_name[STORAGE_NAME_CAP] = { 0 };
    uint32_t records = svc_attendance_records();

    for (;;) {
        app_presence_t edge = APP_PRESENCE_OFF;
        while (xQueueReceive(wiring->presence, &edge, 0) == pdTRUE) {
            svc_attendance_on_presence(edge == APP_PRESENCE_ON);
        }
        svc_vision_result_t result;
        if (xQueueReceive(wiring->results, &result, pdMS_TO_TICKS(ATTEND_TICK_MS)) == pdTRUE) {
            last_kind = result.kind;
            last_employee = result.employee_id;
            memcpy(last_name, result.name, sizeof(last_name));
            svc_attendance_on_vision(&result, sys_time_now_ms());
        }
        svc_attendance_tick(sys_time_now_ms());

        const svc_attendance_state_t state = svc_attendance_state();
        if (state != last_state) {
            ESP_LOGI(TAG, "attendance state %d to %d on vision %d", (int)last_state, (int)state,
                     (int)last_kind);
            last_state = state;
            ui_kiosk_on_verdict(verdict_for(state, last_kind), last_employee, last_name);
            announce(wiring, state, last_kind);
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
    { attend_task, "attend", ATTEND_TASK_STACK_BYTES, ATTEND_TASK_PRIORITY, ATTEND_TASK_CORE, 0 },
    { net_task, "net", NET_TASK_STACK_BYTES, NET_TASK_PRIORITY, NET_TASK_CORE, 0 },
};

#define TASK_COUNT (sizeof(kTasks) / sizeof(kTasks[0]))

esp_err_t app_tasks_start(void)
{
    const app_wiring_t *wiring = app_wiring();
    if (wiring == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
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
