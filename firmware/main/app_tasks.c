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
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "net_wifi.h"
#include "storage_format.h"
#include "svc_attendance.h"
#include "svc_facedb.h"
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
#define TOF_TASK_CORE 0
#define TOF_TASK_PRIORITY 6
#define TOF_TASK_STACK_BYTES 3072
#define TOF_POLL_MS 100
#define PRESENCE_WAIT_MS 50
#define SOUND_WAIT_MS 20
#define REST_ALL_MS 60000
#define REST_POLL_MS 40
#define SCREEN_DIM_PERCENT 0
#define UI_BACKLIGHT_PERCENT 100
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
#define SETTINGS_LINE_CAP 40
#define NET_TASK_CORE 0
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
#define TOUCH_REST_POLL_MS 160
#define TOUCH_POINTS 1
#define UI_TASK_CORE 0
#define UI_TASK_PRIORITY 4
#define UI_TASK_STACK_BYTES 8192
#define UI_TICK_MS 20
#define UI_REST_TICK_MS 200
#define UI_GROUND_RGB565 0x0821
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
            drv_lcd_backlight(UI_BACKLIGHT_PERCENT);
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
            if (ui_kiosk_enrolling()) {
                // Enrolling keeps attendance out of it, but a refused sample still
                // has to reach the glass or the screen waits mute (KEHOACH 4.5.5h.2).
                if (result.kind == SVC_VISION_SPOOF) {
                    ui_kiosk_enrol_refused();
                }
            // A dropped MATCH is an attendance nobody ever records (KEHOACH 5.3).
            } else if (xQueueSend(wiring->results, &result, pdMS_TO_TICKS(RESULT_WAIT_MS)) !=
                       pdTRUE) {
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
        const bool resting = rest_level() == REST_ALL;
        vTaskDelay(pdMS_TO_TICKS(resting ? TOUCH_REST_POLL_MS : TOUCH_POLL_MS));
        drv_touch_point_t points[TOUCH_POINTS];
        uint8_t count = 0;
        if (drv_touch_read(points, TOUCH_POINTS, &count) != ESP_OK || count == 0) {
            ui_kiosk_on_touch(false, 0, 0);
            continue;
        }
        stay_awake("touch");
        ui_kiosk_on_touch(true, points[0].x, points[0].y);
    }
}

// Main is the one layer that can see all of these, and none of them costs a
// flash read, so the page stays cheap to refresh (KEHOACH 4.5.5h.4).
static void show_settings(void)
{
    static char text[UI_KIOSK_SETTINGS_LINES][SETTINGS_LINE_CAP];
    const char *lines[UI_KIOSK_SETTINGS_LINES];
    const esp_app_desc_t *app = esp_app_get_description();
    int n = 0;
    snprintf(text[n], SETTINGS_LINE_CAP, "Phiên bản: %.20s", app != NULL ? app->version : "?");
    lines[n] = text[n];
    ++n;
    snprintf(text[n], SETTINGS_LINE_CAP, "Wi-Fi: %s, rớt %" PRIu32 " lần",
             net_wifi_is_connected() ? "đã nối" : "chưa nối", net_wifi_disconnects());
    lines[n] = text[n];
    ++n;
    snprintf(text[n], SETTINGS_LINE_CAP, "Người trong bảng: %u", (unsigned)svc_facedb_count());
    lines[n] = text[n];
    ++n;
    snprintf(text[n], SETTINGS_LINE_CAP, "Bản ghi chấm công: %" PRIu32, svc_attendance_records());
    lines[n] = text[n];
    ++n;
    snprintf(text[n], SETTINGS_LINE_CAP, "Bật máy trong: %" PRIu32 " cm",
             atomic_load(&s_gate_mm) / 10);
    lines[n] = text[n];
    ++n;
    snprintf(text[n], SETTINGS_LINE_CAP, "Mặt nhỏ nhất: %d px", svc_vision_face_min_px());
    lines[n] = text[n];
    ++n;
    snprintf(text[n], SETTINGS_LINE_CAP, "RAM nội còn: %u KB",
             (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT) / 1024));
    lines[n] = text[n];
    ++n;
    ui_kiosk_set_settings(lines, n);
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

// The screens ask for a face and svc_vision answers with the next one it
// embeds, so the enrol flow needs no camera path of its own (KEHOACH 4.5.5h).
static void ui_task(void *arg)
{
    (void)arg;
    bool armed = false;
    bool enrolling = false;
    uint32_t new_employee = 0;

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
        }
        enrolling = now_enrolling;
        if (armed && !svc_vision_enrol_pending()) {
            armed = false;
            ui_kiosk_enrol_kept();
        }
        if (ui_kiosk_take_people_request()) {
            show_people();
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
        // All three samples of one person share the id taken for the first
        // (KEHOACH 4.5.5h.2).
        if (employee_id == 0) {
            new_employee = new_employee != 0 ? new_employee : svc_facedb_next_employee_id();
            employee_id = new_employee;
        }
        if (employee_id == 0) {
            ESP_LOGE(TAG, "no id for %s, face table did not answer", name);
            continue;
        }
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

// The kiosk speaks only when it opens the door: a refusal is already on the
// glass, and a sound would announce it to the room (KEHOACH 6.2.8).
static void announce(const app_wiring_t *wiring, svc_attendance_state_t state)
{
    if (state != SVC_ATTENDANCE_GRANTED) {
        return;
    }
    const app_sound_t sound = APP_SOUND_OK;
    if (xQueueSend(wiring->sounds, &sound, pdMS_TO_TICKS(SOUND_WAIT_MS)) != pdTRUE) {
        ESP_LOGW(TAG, "grant sound dropped, audio queue full");
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
            // Aiming guidance has its own channel, and letting it through here
            // downgrades a refusal into a vague one (KEHOACH 4.5.5h.1).
            const bool verdict_about_a_face = result.kind == SVC_VISION_MATCH ||
                                              result.kind == SVC_VISION_UNKNOWN ||
                                              result.kind == SVC_VISION_SPOOF;
            if (verdict_about_a_face) {
                last_kind = result.kind;
                last_employee = result.employee_id;
                memcpy(last_name, result.name, sizeof(last_name));
            }
            svc_attendance_on_vision(&result, sys_time_now_ms());
        }
        svc_attendance_tick(sys_time_now_ms());

        {
            static int64_t settings_at_ms;
            // Nobody can read a sleeping panel, and the page walks the heap.
            const bool readable = rest_level() != REST_ALL;
            if (readable && sys_time_now_ms() - settings_at_ms > SETTINGS_REFRESH_MS) {
                settings_at_ms = sys_time_now_ms();
                show_settings();
            }
        }
        const svc_attendance_state_t state = svc_attendance_state();
        if (state != last_state) {
            ESP_LOGI(TAG, "attendance state %d to %d on vision %d", (int)last_state, (int)state,
                     (int)last_kind);
            last_state = state;
            ui_kiosk_on_verdict(verdict_for(state, last_kind), last_employee, last_name);
            announce(wiring, state);
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
