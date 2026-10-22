#include "app_boot.h"

#include <math.h>
#include <string.h>

#include <inttypes.h>

#include "ai_engine.h"
#include "app_config.h"
#include "app_events.h"
#include "app_wiring.h"
#include "bsp_board.h"
#include "drv_audio.h"
#include "drv_camera.h"
#include "drv_ioexp.h"
#include "drv_lcd.h"
#include "drv_servo.h"
#include "drv_tof.h"
#include "drv_touch.h"
#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "net_ota.h"
#include "net_wifi.h"
#include "svc_attendance.h"
#include "svc_door.h"
#include "svc_facedb.h"
#include "svc_vision.h"
#include "sys_storage.h"
#include "sys_time.h"
#include "ui_kiosk.h"

static const char *TAG = "app_boot";
static esp_err_t models_error = ESP_OK;
static esp_err_t table_error = ESP_OK;

#define BOOT_MARK_MAGIC 0x424D4B31u

typedef enum {
    BOOT_STEP_NONE,
    BOOT_STEP_STORAGE,
    BOOT_STEP_MODELS,
    BOOT_STEP_WIRING,
    BOOT_STEP_BOARD,
    BOOT_STEP_LCD,
    BOOT_STEP_UI,
    BOOT_STEP_IOEXP,
    BOOT_STEP_CLOCK,
    BOOT_STEP_TOUCH,
    BOOT_STEP_TOF,
    BOOT_STEP_CAMERA,
    BOOT_STEP_VISION,
    BOOT_STEP_SERVO,
    BOOT_STEP_ZONE,
    BOOT_STEP_AUDIO,
    BOOT_STEP_ATTENDANCE,
    BOOT_STEP_WIFI,
    BOOT_STEP_RUNNING,
    BOOT_STEP_COUNT,
} boot_step_t;

static const char *const kStepNames[BOOT_STEP_COUNT] = {
    [BOOT_STEP_STORAGE] = "storage",
    [BOOT_STEP_MODELS] = "models",
    [BOOT_STEP_WIRING] = "wiring",
    [BOOT_STEP_BOARD] = "board",
    [BOOT_STEP_LCD] = "lcd",
    [BOOT_STEP_UI] = "ui",
    [BOOT_STEP_IOEXP] = "ioexp",
    [BOOT_STEP_CLOCK] = "clock",
    [BOOT_STEP_TOUCH] = "touch",
    [BOOT_STEP_TOF] = "tof",
    [BOOT_STEP_CAMERA] = "camera",
    [BOOT_STEP_VISION] = "vision",
    [BOOT_STEP_SERVO] = "servo",
    [BOOT_STEP_ZONE] = "zone",
    [BOOT_STEP_AUDIO] = "audio",
    [BOOT_STEP_ATTENDANCE] = "attendance",
    [BOOT_STEP_WIFI] = "wifi",
    [BOOT_STEP_RUNNING] = "running",
};

// RTC memory outlives every reset but a power cut, so the next boot can name where this one stopped (KEHOACH 4.6).
static RTC_NOINIT_ATTR uint32_t s_mark_magic;
static RTC_NOINIT_ATTR uint32_t s_mark_step;
static const char *s_last_step;

#define NVS_RTC_NTP_SET "rtc_ntp_set"
#define NVS_SEED_VER "seed_ver"
#define NVS_TZ "tz"
#define TZ_CAP 40
// Raise only when a seed below changes, and read KEHOACH 6.2.1 first: it
// overwrites whatever SET_CONFIG had put there.
#define APP_SEED_VER 7
#define NVS_GUIDE_MIN "guide_min"
#define NVS_ALLOW_NO_SPOOF "allow_no_spoof"
#define PERMILLE 1000.0f
#define PERCENT 100.0f
#define MODEL_ENTRY_DETECT "detect"
#define MODEL_ENTRY_SPOOF "spoof"
#define MODEL_ENTRY_RECOG "recog"

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
    { STORAGE_NS_VISION, STORAGE_KEY_FACE_MIN_PX, CONFIG_VISION_SEED_FACE_MIN_PX },
    { STORAGE_NS_VISION, NVS_GUIDE_MIN, CONFIG_VISION_SEED_GUIDE_MIN_PERCENT },
    { STORAGE_NS_VISION, STORAGE_KEY_PRESENT_MM, CONFIG_VISION_SEED_PRESENT_MM },
    { STORAGE_NS_ATTEND, STORAGE_KEY_DEDUP_MIN, CONFIG_ATTEND_SEED_DEDUP_MIN },
    { STORAGE_NS_ATTEND, NVS_ALLOW_NO_SPOOF, ATTEND_SEED_ALLOW_NO_SPOOF },
    { STORAGE_NS_UI, STORAGE_KEY_BRIGHTNESS, CONFIG_UI_SEED_BRIGHTNESS },
    { STORAGE_NS_UI, STORAGE_KEY_VOLUME, CONFIG_UI_SEED_VOLUME },
};

// The one failure a kiosk can undo alone, and last_ota_result is what stops it
// undoing the same thing twice (KEHOACH 6.2.1).
static void load_models(void)
{
    const esp_err_t loaded = ai_engine_init();
    uint32_t trial = 0;
    sys_storage_get_u32(STORAGE_NS_SYS, STORAGE_KEY_LAST_OTA, &trial);
    // A slot on trial that loads is judged once vision is up (settle_models).
    if (loaded == ESP_OK) {
        return;
    }
    ESP_LOGE(TAG, "models would not load: %s", esp_err_to_name(loaded));
    if (trial != STORAGE_OTA_MODELS_ON_TRIAL) {
        // Nothing to go back to, so the kiosk says so and runs blind rather than rebooting into the same wall.
        models_error = loaded;
        return;
    }
    sys_storage_set_u32(STORAGE_NS_SYS, STORAGE_KEY_LAST_OTA, STORAGE_OTA_MODELS_UNDONE);
    sys_storage_models_revert();
    esp_restart();
}

// Every branch answers one inference on a blank input, in the shape the kiosk reads back.
static bool models_answer(void)
{
    const size_t detect = ai_engine_detect_input_bytes();
    const size_t spoof = ai_engine_spoof_input_bytes();
    const size_t recog = ai_engine_recog_input_bytes();
    if (detect == 0 || spoof == 0 || recog == 0 || ai_engine_recog_output_bytes() != STORAGE_EMBED_DIM) {
        return false;
    }
    size_t most = detect > spoof ? detect : spoof;
    most = most > recog ? most : recog;
    // The embedding rides behind the input: the main task's stack is sized for setup, not for a model pass.
    int8_t *blank = heap_caps_calloc(1, most + STORAGE_EMBED_DIM, MALLOC_CAP_SPIRAM);
    if (blank == NULL) {
        return false;
    }
    float live = -1.0f;
    float scale = 0.0f;
    int8_t *embedding = blank + most;
    const bool answered = ai_engine_detect(blank) == ESP_OK && ai_engine_spoof(blank, &live) == ESP_OK &&
                          ai_engine_recognize(blank, embedding, STORAGE_EMBED_DIM, &scale) == ESP_OK;
    heap_caps_free(blank);
    return answered && live >= 0.0f && live <= 1.0f && isfinite(scale) && scale > 0.0f;
}

// Building the graphs proves too little: a pack is kept once vision is up and every branch answers (KEHOACH 7.7).
static void settle_models(EventGroupHandle_t flags)
{
    uint32_t trial = 0;
    if (sys_storage_get_u32(STORAGE_NS_SYS, STORAGE_KEY_LAST_OTA, &trial) != ESP_OK ||
        trial != STORAGE_OTA_MODELS_ON_TRIAL) {
        return;
    }
    const bool up = (xEventGroupGetBits(flags) & APP_EG_AI_READY) != 0;
    if (up && models_answer()) {
        sys_storage_set_u32(STORAGE_NS_SYS, STORAGE_KEY_LAST_OTA, STORAGE_OTA_MODELS_KEPT);
        ESP_LOGW(TAG, "models slot %u keeps the seat", (unsigned)sys_storage_models_slot());
        return;
    }
    ESP_LOGE(TAG, "models slot %u %s, going back", (unsigned)sys_storage_models_slot(),
             up ? "gave a wrong answer" : "brought no vision up");
    sys_storage_set_u32(STORAGE_NS_SYS, STORAGE_KEY_LAST_OTA, STORAGE_OTA_MODELS_UNDONE);
    sys_storage_models_revert();
    esp_restart();
}

static bool rtc_ntp_marker(void)
{
    uint32_t marker = 0;
    return sys_storage_get_u32(STORAGE_NS_SYS, NVS_RTC_NTP_SET, &marker) == ESP_OK && marker != 0;
}

// The marker tells a later boot what the RTC holds, and only sys_storage may write it (KEHOACH 6.2.5).
static void on_time_synced(bool rtc_ntp_set, void *arg)
{
    (void)arg;
    const esp_err_t err =
        sys_storage_set_u32(STORAGE_NS_SYS, NVS_RTC_NTP_SET, rtc_ntp_set ? 1u : 0u);
    ESP_LOGI(TAG, "time verified by %s, marker %d: %s",
             sys_time_source() == SYS_TIME_SOURCE_API ? "the api" : "ntp", (int)rtc_ntp_set,
             esp_err_to_name(err));
    const app_wiring_t *wiring = app_wiring();
    if (wiring != NULL) {
        xEventGroupSetBits(wiring->flags, APP_EG_TIME_OK);
    }
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

uint8_t app_boot_brightness_pct(void)
{
    const uint32_t stored = setting(STORAGE_NS_UI, STORAGE_KEY_BRIGHTNESS, CONFIG_UI_SEED_BRIGHTNESS);
    if (stored < CONFIG_UI_MIN_BRIGHTNESS) {
        return CONFIG_UI_MIN_BRIGHTNESS;
    }
    return (uint8_t)(stored > 100 ? 100 : stored);
}

// The threshold the running image carries for one entry, 0 for an entry it lacks (KEHOACH 6.2.2).
static float model_threshold(const char *entry)
{
    const storage_models_header_t *header = NULL;
    if (sys_storage_models_open(&header) == ESP_OK && header != NULL) {
        for (uint32_t i = 0; i < header->count && i < STORAGE_MODEL_COUNT; ++i) {
            if (strcmp(header->entry[i].name, entry) == 0) {
                return header->threshold_permille[i] / PERMILLE;
            }
        }
    }
    return 0.0f;
}

static svc_vision_thresholds_t vision_thresholds(void)
{
    svc_vision_thresholds_t thresholds = {
        .detect_min_score = model_threshold(MODEL_ENTRY_DETECT),
        .live_min_score = model_threshold(MODEL_ENTRY_SPOOF),
        .match_min_score = model_threshold(MODEL_ENTRY_RECOG),
        .face_min_px = (int)setting(STORAGE_NS_VISION, STORAGE_KEY_FACE_MIN_PX,
                                    CONFIG_VISION_SEED_FACE_MIN_PX),
        .guide_min_share =
            setting(STORAGE_NS_VISION, NVS_GUIDE_MIN, CONFIG_VISION_SEED_GUIDE_MIN_PERCENT) /
            PERCENT,
    };
    // The pipeline judges the very rectangle the screen draws (KEHOACH 4.5.5d).
    int16_t guide[4];
    ui_kiosk_guide(guide);
    drv_lcd_panel_to_frame(APP_CAM_H_RES, APP_CAM_V_RES, guide, thresholds.guide);
    return thresholds;
}

static svc_attendance_policy_t attend_policy(void)
{
    const svc_attendance_policy_t policy = {
        .dedup_min = setting(STORAGE_NS_ATTEND, STORAGE_KEY_DEDUP_MIN, CONFIG_ATTEND_SEED_DEDUP_MIN),
        .allow_no_spoof =
            setting(STORAGE_NS_ATTEND, NVS_ALLOW_NO_SPOOF, ATTEND_SEED_ALLOW_NO_SPOOF) != 0,
    };
    return policy;
}

static bool running_recog_tag(uint8_t *tag)
{
    const storage_models_header_t *header = NULL;
    if (sys_storage_models_open(&header) != ESP_OK || header == NULL) {
        return false;
    }
    for (uint32_t i = 0; i < header->count && i < STORAGE_MODEL_COUNT; ++i) {
        if (strcmp(header->entry[i].name, MODEL_ENTRY_RECOG) == 0) {
            memcpy(tag, header->entry[i].sha256, STORAGE_MODEL_TAG_LEN);
            return true;
        }
    }
    return false;
}

// Templates of another recognition model live in another space, so they go (KEHOACH 7.5).
// A roster number means something only beside a table that loaded, so an empty one asks for all of it (KEHOACH 6.2.4).
static void forget_lost_table(void)
{
    const esp_err_t loaded = svc_facedb_load_error();
    if (loaded == ESP_OK) {
        return;
    }
    uint32_t held = 0;
    sys_storage_get_u32(STORAGE_NS_DEVICE, STORAGE_KEY_ROSTER_VER, &held);
    if (loaded == ESP_ERR_NOT_FOUND && held == 0) {
        return;
    }
    if (held != 0) {
        sys_storage_set_u32(STORAGE_NS_DEVICE, STORAGE_KEY_ROSTER_VER, 0);
    }
    table_error = loaded;
    ESP_LOGW(TAG, "face table %s under roster %" PRIu32 ", asking for all of it",
             esp_err_to_name(loaded), held);
}

static void bind_face_table(bool may_save)
{
    uint8_t tag[STORAGE_MODEL_TAG_LEN];
    if (!running_recog_tag(tag)) {
        ESP_LOGW(TAG, "no recog model in the image, face table left untagged");
        return;
    }
    svc_facedb_bind_t outcome = SVC_FACEDB_BIND_KEPT;
    const esp_err_t bound = svc_facedb_bind_model(tag, &outcome);
    if (bound != ESP_OK) {
        ESP_LOGE(TAG, "face table not tied to the model: %s", esp_err_to_name(bound));
        return;
    }
    if (outcome == SVC_FACEDB_BIND_DROPPED) {
        // The cursor goes first, so a power cut mid-save still leaves the server a resync to send.
        sys_storage_set_u32(STORAGE_NS_DEVICE, STORAGE_KEY_ROSTER_VER, 0);
        ESP_LOGW(TAG, "face table held another recognition model, all dropped: %s",
                 esp_err_to_name(svc_facedb_persist()));
    } else if (outcome == SVC_FACEDB_BIND_STAMPED && may_save && !net_ota_on_trial()) {
        // An image on trial saves at sign-off, so a rollback reads its own format (KEHOACH 6.2.4).
        ESP_LOGI(TAG, "face table stamped with the running model: %s",
                 esp_err_to_name(svc_facedb_persist()));
    }
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
    forget_lost_table();
    const esp_err_t loaded = svc_facedb_load_error();
    // A file this build could not read stays on flash until the resync saves over it.
    bind_face_table(loaded == ESP_OK || loaded == ESP_ERR_NOT_FOUND);
    xEventGroupSetBits(flags, APP_EG_DB_LOADED);
    ESP_LOGI(TAG, "face table holds %u templates", (unsigned)svc_facedb_count());

    const svc_vision_thresholds_t thresholds = vision_thresholds();
    const esp_err_t vision = svc_vision_init(&thresholds);
    if (vision != ESP_OK) {
        ESP_LOGE(TAG, "vision pipeline: %s", esp_err_to_name(vision));
        return;
    }
    xEventGroupSetBits(flags, APP_EG_AI_READY);
    ESP_LOGI(TAG, "vision up: detect %.3f, live %.3f, match %.3f from the models image, face %d px",
             thresholds.detect_min_score, thresholds.live_min_score, thresholds.match_min_score,
             thresholds.face_min_px);
}

esp_err_t app_boot_models_error(void)
{
    return models_error;
}

esp_err_t app_boot_table_error(void)
{
    return table_error;
}

static void reach(boot_step_t step)
{
    s_mark_step = (uint32_t)step;
    s_mark_magic = BOOT_MARK_MAGIC;
}

// A power-on leaves noise in the RTC words and has no previous boot to tell of.
static const char *previous_step(void)
{
    if (esp_reset_reason() == ESP_RST_POWERON || s_mark_magic != BOOT_MARK_MAGIC ||
        s_mark_step == BOOT_STEP_NONE || s_mark_step >= BOOT_STEP_COUNT) {
        return NULL;
    }
    return kStepNames[s_mark_step];
}

const char *app_boot_last_step(void)
{
    return s_last_step;
}

const char *app_boot_reset_cause(void)
{
    switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "power on";
    case ESP_RST_EXT: return "external pin";
    case ESP_RST_SW: return "esp_restart";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "interrupt watchdog";
    case ESP_RST_TASK_WDT: return "task watchdog";
    case ESP_RST_WDT: return "other watchdog";
    case ESP_RST_DEEPSLEEP: return "deep sleep";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_SDIO: return "sdio";
    case ESP_RST_USB: return "usb";
    case ESP_RST_JTAG: return "jtag";
    case ESP_RST_EFUSE: return "efuse";
    case ESP_RST_PWR_GLITCH: return "power glitch";
    case ESP_RST_CPU_LOCKUP: return "cpu lockup";
    default: return "unknown";
    }
}

esp_err_t app_boot(void)
{
    s_last_step = previous_step();
    reach(BOOT_STEP_STORAGE);
    ESP_ERROR_CHECK(sys_storage_init());
    char device_id[STORAGE_DEVICE_ID_CAP] = { 0 };
    if (sys_storage_device_id(device_id, sizeof(device_id)) != ESP_OK) {
        ESP_LOGE(TAG, "no device id: nothing this kiosk records can be attributed");
    }
    ESP_LOGI(TAG, "kiosk %s, boot %" PRIu32 ", reset by %s, last step %s", device_id, sys_storage_boot_count(),
             app_boot_reset_cause(), s_last_step != NULL ? s_last_step : "unknown");
    // The arena needs one contiguous run the drivers below would fragment (KEHOACH 3.8).
    reach(BOOT_STEP_MODELS);
    load_models();
    reach(BOOT_STEP_WIRING);
    ESP_ERROR_CHECK(app_wiring_init());
    seed_settings();
    reach(BOOT_STEP_BOARD);
    ESP_ERROR_CHECK(bsp_board_init());
    reach(BOOT_STEP_LCD);
    ESP_ERROR_CHECK(drv_lcd_init());
    const uint8_t lamp = app_boot_brightness_pct();
    const uint8_t loud = (uint8_t)setting(STORAGE_NS_UI, STORAGE_KEY_VOLUME, CONFIG_UI_SEED_VOLUME);
    ESP_ERROR_CHECK(drv_lcd_backlight(lamp));
    reach(BOOT_STEP_UI);
    ESP_ERROR_CHECK(ui_kiosk_init());
    ui_kiosk_set_levels(lamp, loud);
    // An absent key reads as an empty string, which the kiosk takes as Vietnamese.
    char lang[8] = { 0 };
    sys_storage_get_str(STORAGE_NS_UI, STORAGE_KEY_LANG, lang, sizeof(lang));
    ui_kiosk_set_language(lang);
    reach(BOOT_STEP_IOEXP);
    ESP_ERROR_CHECK(drv_ioexp_init());
    reach(BOOT_STEP_CLOCK);
    // A silent clock costs the trust of a timestamp, not the kiosk (KEHOACH 6.2.5).
    const esp_err_t clock = sys_time_init(rtc_ntp_marker(), on_time_synced, NULL);
    if (clock != ESP_OK) {
        ESP_LOGW(TAG, "no clock from the rtc: %s", esp_err_to_name(clock));
    }
    reach(BOOT_STEP_TOUCH);
    // A dead panel costs the settings screen, not the kiosk (KEHOACH 6.2.2).
    const esp_err_t touch = drv_touch_init();
    if (touch != ESP_OK) {
        ESP_LOGW(TAG, "touch absent: %s", esp_err_to_name(touch));
    }
    reach(BOOT_STEP_TOF);
    // No ranging means nothing wakes the pipeline, so the kiosk is a preview.
    const esp_err_t tof = drv_tof_init();
    if (tof != ESP_OK) {
        ESP_LOGW(TAG, "tof absent: %s", esp_err_to_name(tof));
    }
    reach(BOOT_STEP_CAMERA);
    ESP_ERROR_CHECK(drv_camera_init());
    reach(BOOT_STEP_VISION);
    start_vision(app_wiring()->flags);
    settle_models(app_wiring()->flags);

    // A door that takes no pulse is a miswired kiosk: granting with nothing to open is worse than not booting.
    reach(BOOT_STEP_SERVO);
    ESP_ERROR_CHECK(drv_servo_init());
    reach(BOOT_STEP_ZONE);
    char zone[TZ_CAP] = { 0 };
    // A key present but empty is the same as absent, as sntp_host is (KEHOACH 4.5).
    if (sys_storage_get_str(STORAGE_NS_DEVICE, NVS_TZ, zone, sizeof(zone)) != ESP_OK ||
        zone[0] == '\0') {
        strlcpy(zone, CONFIG_SYS_TIME_TZ, sizeof(zone));
    }
    ESP_ERROR_CHECK(sys_time_set_zone(zone));

    reach(BOOT_STEP_AUDIO);
    // A kiosk with no voice still opens doors, so the amplifier only warns.
    const esp_err_t amplifier = drv_audio_init();
    if (amplifier != ESP_OK) {
        ESP_LOGW(TAG, "audio down: %s", esp_err_to_name(amplifier));
    }
    if (drv_audio_set_volume(loud) != ESP_OK) {
        ESP_LOGW(TAG, "volume %u out of range, playing at full", (unsigned)loud);
    }
    reach(BOOT_STEP_ATTENDANCE);
    const svc_attendance_policy_t policy = attend_policy();
    ESP_ERROR_CHECK(svc_attendance_init(svc_door_servo(), &policy));
    reach(BOOT_STEP_WIFI);
    // A kiosk with no network still opens doors (KEHOACH 6.2.5).
    const esp_err_t station = net_wifi_start();
    if (station != ESP_OK) {
        ESP_LOGW(TAG, "wifi down: %s", esp_err_to_name(station));
    }
    reach(BOOT_STEP_RUNNING);
    return ESP_OK;
}
