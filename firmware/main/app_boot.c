#include "app_boot.h"

#include <inttypes.h>

#include "ai_engine.h"
#include "app_events.h"
#include "app_wiring.h"
#include "bsp_board.h"
#include "drv_camera.h"
#include "drv_ioexp.h"
#include "drv_lcd.h"
#include "drv_servo.h"
#include "drv_tof.h"
#include "drv_touch.h"
#include "esp_log.h"
#include "net_wifi.h"
#include "svc_attendance.h"
#include "svc_door.h"
#include "svc_facedb.h"
#include "svc_vision.h"
#include "sys_storage.h"
#include "sys_time.h"
#include "ui_kiosk.h"

static const char *TAG = "app_boot";

#define NVS_RTC_NTP_SET "rtc_ntp_set"
#define NVS_SEED_VER "seed_ver"
// Raise only when a seed below changes, and read KEHOACH 6.2.1 first: it
// overwrites whatever SET_CONFIG had put there.
#define APP_SEED_VER 1
#define NVS_DETECT_MIN "detect_min"
#define NVS_LIVE_MIN "live_min"
#define NVS_MATCH_MIN "match_min"
#define NVS_FACE_MIN_PX "face_min_px"
#define NVS_PRESENT_MM "present_mm"
#define NVS_DEDUP_MIN "dedup_min"
#define NVS_ALLOW_NO_SPOOF "allow_no_spoof"
#define PERMILLE 1000.0f

#ifdef CONFIG_ATTEND_SEED_ALLOW_NO_SPOOF
#define ATTEND_SEED_ALLOW_NO_SPOOF 1u
#else
#define ATTEND_SEED_ALLOW_NO_SPOOF 0u
#endif

typedef struct {
    const char *ns;
    const char *key;
    uint32_t seed;
} app_seed_t;

static const app_seed_t kSeeds[] = {
    { STORAGE_NS_VISION, NVS_DETECT_MIN, CONFIG_VISION_SEED_DETECT_MIN_PERMILLE },
    { STORAGE_NS_VISION, NVS_LIVE_MIN, CONFIG_VISION_SEED_LIVE_MIN_PERMILLE },
    { STORAGE_NS_VISION, NVS_MATCH_MIN, CONFIG_VISION_SEED_MATCH_MIN_PERMILLE },
    { STORAGE_NS_VISION, NVS_FACE_MIN_PX, CONFIG_VISION_SEED_FACE_MIN_PX },
    { STORAGE_NS_VISION, NVS_PRESENT_MM, CONFIG_VISION_SEED_PRESENT_MM },
    { STORAGE_NS_ATTEND, NVS_DEDUP_MIN, CONFIG_ATTEND_SEED_DEDUP_MIN },
    { STORAGE_NS_ATTEND, NVS_ALLOW_NO_SPOOF, ATTEND_SEED_ALLOW_NO_SPOOF },
};

static bool rtc_ntp_marker(void)
{
    uint32_t marker = 0;
    return sys_storage_get_u32(STORAGE_NS_SYS, NVS_RTC_NTP_SET, &marker) == ESP_OK && marker != 0;
}

// KEHOACH 6.2.1: NVS owns a threshold once it is seeded, and only a seed
// version the device has not reached yet may write over that.
static void seed_settings(void)
{
    uint32_t device_ver = 0;
    const bool stale = sys_storage_get_u32(STORAGE_NS_SYS, NVS_SEED_VER, &device_ver) != ESP_OK ||
                       device_ver < APP_SEED_VER;
    for (size_t i = 0; i < sizeof(kSeeds) / sizeof(kSeeds[0]); ++i) {
        uint32_t stored = 0;
        const bool present = sys_storage_get_u32(kSeeds[i].ns, kSeeds[i].key, &stored) == ESP_OK;
        if (present && (!stale || stored == kSeeds[i].seed)) {
            continue;
        }
        const esp_err_t err = sys_storage_set_u32(kSeeds[i].ns, kSeeds[i].key, kSeeds[i].seed);
        ESP_LOGW(TAG, "%s/%s %" PRIu32 " to seed %" PRIu32 ": %s", kSeeds[i].ns, kSeeds[i].key,
                 present ? stored : 0, kSeeds[i].seed, esp_err_to_name(err));
    }
    if (stale) {
        ESP_LOGI(TAG, "seed set %" PRIu32 " to %d", device_ver, APP_SEED_VER);
        sys_storage_set_u32(STORAGE_NS_SYS, NVS_SEED_VER, APP_SEED_VER);
    }
}

static uint32_t setting(const char *ns, const char *key, uint32_t fallback)
{
    uint32_t value = 0;
    return sys_storage_get_u32(ns, key, &value) == ESP_OK ? value : fallback;
}

static svc_vision_thresholds_t vision_thresholds(void)
{
    const svc_vision_thresholds_t thresholds = {
        .detect_min_score =
            setting(STORAGE_NS_VISION, NVS_DETECT_MIN, CONFIG_VISION_SEED_DETECT_MIN_PERMILLE) /
            PERMILLE,
        .live_min_score =
            setting(STORAGE_NS_VISION, NVS_LIVE_MIN, CONFIG_VISION_SEED_LIVE_MIN_PERMILLE) /
            PERMILLE,
        .match_min_score =
            setting(STORAGE_NS_VISION, NVS_MATCH_MIN, CONFIG_VISION_SEED_MATCH_MIN_PERMILLE) /
            PERMILLE,
        .face_min_px =
            (int)setting(STORAGE_NS_VISION, NVS_FACE_MIN_PX, CONFIG_VISION_SEED_FACE_MIN_PX),
    };
    return thresholds;
}

static svc_attendance_policy_t attend_policy(void)
{
    const svc_attendance_policy_t policy = {
        .dedup_min = setting(STORAGE_NS_ATTEND, NVS_DEDUP_MIN, CONFIG_ATTEND_SEED_DEDUP_MIN),
        .allow_no_spoof =
            setting(STORAGE_NS_ATTEND, NVS_ALLOW_NO_SPOOF, ATTEND_SEED_ALLOW_NO_SPOOF) != 0,
    };
    return policy;
}

// The bits decide which tasks app_tasks_start brings up, so a branch that could
// not open reads as a task that stays down (KEHOACH 5.3).
static void start_vision(EventGroupHandle_t flags)
{
    const esp_err_t db = svc_facedb_init();
    if (db != ESP_OK) {
        ESP_LOGE(TAG, "face table: %s", esp_err_to_name(db));
        return;
    }
    xEventGroupSetBits(flags, APP_EG_DB_LOADED);
    ESP_LOGI(TAG, "face table holds %u templates", (unsigned)svc_facedb_count());

    const svc_vision_thresholds_t thresholds = vision_thresholds();
    const esp_err_t vision = svc_vision_init(&thresholds);
    if (vision != ESP_OK) {
        ESP_LOGE(TAG, "vision pipeline: %s", esp_err_to_name(vision));
        return;
    }
    xEventGroupSetBits(flags, APP_EG_AI_READY);
    ESP_LOGI(TAG, "vision up: detect %.3f, live %.3f, match %.3f, face %d px",
             thresholds.detect_min_score, thresholds.live_min_score, thresholds.match_min_score,
             thresholds.face_min_px);
}

esp_err_t app_boot(void)
{
    ESP_ERROR_CHECK(sys_storage_init());
    // The arena needs one contiguous run the drivers below would fragment (KEHOACH 3.8).
    ESP_ERROR_CHECK(ai_engine_init());
    ESP_ERROR_CHECK(app_wiring_init());
    seed_settings();
    ESP_ERROR_CHECK(bsp_board_init());
    ESP_ERROR_CHECK(drv_lcd_init());
    ESP_ERROR_CHECK(drv_lcd_backlight(100));
    ESP_ERROR_CHECK(ui_kiosk_init());
    ESP_ERROR_CHECK(drv_ioexp_init());
    // A silent clock costs the trust of a timestamp, not the kiosk (KEHOACH 6.2.5).
    const esp_err_t clock = sys_time_init(rtc_ntp_marker());
    if (clock != ESP_OK) {
        ESP_LOGW(TAG, "rtc absent: %s", esp_err_to_name(clock));
    }
    // A dead panel costs the settings screen, not the kiosk (KEHOACH 6.2.2).
    const esp_err_t touch = drv_touch_init();
    if (touch != ESP_OK) {
        ESP_LOGW(TAG, "touch absent: %s", esp_err_to_name(touch));
    }
    // No ranging means nothing wakes the pipeline, so the kiosk is a preview.
    const esp_err_t tof = drv_tof_init();
    if (tof != ESP_OK) {
        ESP_LOGW(TAG, "tof absent: %s", esp_err_to_name(tof));
    }
    ESP_ERROR_CHECK(drv_camera_init());
    start_vision(app_wiring()->flags);

    // A door that will not take a pulse is a miswired kiosk, not a degraded
    // one: granting access with nothing to open is worse than not booting.
    ESP_ERROR_CHECK(drv_servo_init());
    const svc_attendance_policy_t policy = attend_policy();
    ESP_ERROR_CHECK(svc_attendance_init(svc_door_servo(), &policy));
    // A kiosk with no network still opens doors (KEHOACH 6.2.5).
    const esp_err_t station = net_wifi_start();
    if (station != ESP_OK) {
        ESP_LOGW(TAG, "wifi down: %s", esp_err_to_name(station));
    }
    return ESP_OK;
}
