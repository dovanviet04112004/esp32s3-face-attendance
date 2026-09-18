#include "svc_attendance.h"

#include <string.h>

#include "attendance.hpp"
#include "esp_crc.h"
#include "esp_log.h"
#include "sys_storage.h"
#include "sys_time.h"

namespace {

const char *TAG = "svc_attendance";

constexpr uint32_t kGrantedMs = 2500;
constexpr uint32_t kDeniedMs = 2000;
constexpr uint32_t kCooldownMs = 1500;
constexpr uint32_t kVerifyingMs = 5000;
constexpr uint32_t kDoorHoldMs = 3000;
constexpr uint16_t kQ88One = 256;
constexpr int64_t kMinutesToMs = 60 * 1000;
constexpr uint8_t kFlagDoorOpen = 0x01;
constexpr uint8_t kFlagOffline = 0x02;
constexpr uint8_t kFlagTimeUnsynced = 0x04;

attend::St s_state = attend::St::Idle;
svc_door_t s_door = nullptr;
svc_attendance_policy_t s_policy = {};
bool s_ready = false;
int64_t s_state_since_ms = 0;
uint32_t s_seq = 0;
uint32_t s_records = 0;
uint32_t s_last_employee = 0;
int64_t s_last_stamp_ms = 0;
storage_attend_record_t s_last_record = {};
bool s_have_record = false;
bool s_served = false;
bool s_left_since_grant = true;

uint32_t hold_of(attend::St state)
{
    switch (state) {
        case attend::St::Granted:
            return kGrantedMs;
        case attend::St::Denied:
            return kDeniedMs;
        case attend::St::Cooldown:
            return kCooldownMs;
        case attend::St::Verifying:
            return kVerifyingMs;
        default:
            return 0;
    }
}

uint16_t to_q88(float score)
{
    if (score <= 0.0f) {
        return 0;
    }
    const float scaled = score * kQ88One + 0.5f;
    return scaled >= 65535.0f ? 65535u : (uint16_t)scaled;
}

// A face that stops being live between two frames must not ride a stale verdict
// into the door, so the policy is read at the moment of the grant.
bool liveness_allows(float live_score)
{
    return live_score >= 0.0f || s_policy.allow_no_spoof;
}

bool stamped_recently(uint32_t employee_id, int64_t now_ms)
{
    if (!s_served || employee_id != s_last_employee) {
        return false;
    }
    const int64_t window_ms = (int64_t)s_policy.dedup_min * kMinutesToMs;
    return now_ms - s_last_stamp_ms < window_ms;
}

// A face that never left is one arrival, so granting it twice would reopen the
// door and speak again over a stamp already taken (KEHOACH 4.5.5f).
bool same_arrival(const svc_vision_result_t *result, int64_t now_ms)
{
    return !s_left_since_grant && stamped_recently(result->employee_id, now_ms);
}

esp_err_t write_record(const svc_vision_result_t *result, int64_t now_ms, bool door_opened)
{
    storage_attend_record_t record = {};
    record.magic = STORAGE_ATTEND_REC_MAGIC;
    record.local_id = ((uint64_t)sys_storage_boot_count() << 32) | ++s_seq;
    record.employee_id = result->employee_id;
    record.ts_ms = now_ms;
    record.direction = 0;
    record.match_score = to_q88(result->match_score);
    record.liveness_score = to_q88(result->live_score);
    record.flags = (uint8_t)((door_opened ? kFlagDoorOpen : 0) | kFlagOffline |
                             (sys_time_source() == SYS_TIME_SOURCE_RTC_NTP ? 0 : kFlagTimeUnsynced));
    record.model_version = 1;
    record.crc32 = esp_crc32_le(0, (const uint8_t *)&record, offsetof(storage_attend_record_t, crc32));

    const esp_err_t err = sys_storage_attend_append(&record);
    if (err == ESP_OK) {
        s_last_record = record;
        s_have_record = true;
        s_last_employee = record.employee_id;
        s_last_stamp_ms = now_ms;
        s_served = true;
        ++s_records;
    }
    ESP_LOGI(TAG, "record %" PRIu32 " employee %" PRIu32 " flags 0x%02X: %s", s_records,
             record.employee_id, record.flags, esp_err_to_name(err));
    return err;
}

void act_on(attend::Act act, const svc_vision_result_t *result, int64_t now_ms)
{
    if (act == attend::Act::Grant) {
        if (!liveness_allows(result->live_score)) {
            ESP_LOGW(TAG, "match with liveness %.3f refused by policy", result->live_score);
            s_state = attend::St::Denied;
            return;
        }
        const bool opened = svc_door_open(s_door, kDoorHoldMs) == ESP_OK;
        s_left_since_grant = false;
        if (stamped_recently(result->employee_id, now_ms)) {
            ESP_LOGI(TAG, "employee %" PRIu32 " stamped inside the window, door only",
                     result->employee_id);
            return;
        }
        write_record(result, now_ms, opened);
        return;
    }
    if (act == attend::Act::Rest) {
        svc_door_close(s_door);
    }
}

attend::Ev event_of(svc_vision_kind_t kind, bool *carries)
{
    *carries = true;
    switch (kind) {
        case SVC_VISION_NO_FACE:
            return attend::Ev::NoFace;
        case SVC_VISION_FACE_SMALL:
            return attend::Ev::FaceSmall;
        case SVC_VISION_SPOOF:
            return attend::Ev::Spoof;
        case SVC_VISION_UNKNOWN:
            return attend::Ev::Unknown;
        case SVC_VISION_MATCH:
            return attend::Ev::Match;
        default:
            *carries = false;
            return attend::Ev::Timeout;
    }
}

// A timeout carries a blank result, so only the events that looked at a face may
// be read as saying who is standing there.
bool about_a_face(attend::Ev event)
{
    return event == attend::Ev::Match || event == attend::Ev::Unknown ||
           event == attend::Ev::Spoof || event == attend::Ev::FaceSmall;
}

void apply(attend::Ev event, const svc_vision_result_t *result, int64_t now_ms)
{
    // An empty frame is not the only way the last person leaves: a queue keeps a
    // face in shot throughout, so anyone else being seen ends their turn too.
    if (event == attend::Ev::NoFace || event == attend::Ev::PresenceOff ||
        (about_a_face(event) && result->employee_id != s_last_employee)) {
        s_left_since_grant = true;
    }
    const attend::Step step = attend::next(s_state, event);
    if (!step.moved || (step.act == attend::Act::Grant && same_arrival(result, now_ms))) {
        return;
    }
    s_state = step.to;
    s_state_since_ms = now_ms;
    act_on(step.act, result, now_ms);
}

}  // namespace

extern "C" esp_err_t svc_attendance_init(svc_door_t door, const svc_attendance_policy_t *policy)
{
    if (door == nullptr || policy == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    s_door = door;
    s_policy = *policy;
    s_state = attend::St::Idle;
    s_state_since_ms = 0;
    s_left_since_grant = true;
    s_ready = true;
    ESP_LOGI(TAG, "up, dedup %" PRIu32 " min, no-spoof grants %s", s_policy.dedup_min,
             s_policy.allow_no_spoof ? "allowed" : "refused");
    return ESP_OK;
}

extern "C" esp_err_t svc_attendance_set_policy(const svc_attendance_policy_t *policy)
{
    if (policy == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    s_policy = *policy;
    ESP_LOGI(TAG, "policy now dedup %" PRIu32 " min, no-spoof grants %s", s_policy.dedup_min,
             s_policy.allow_no_spoof ? "allowed" : "refused");
    return ESP_OK;
}

extern "C" esp_err_t svc_attendance_on_vision(const svc_vision_result_t *result, int64_t now_ms)
{
    if (!s_ready || result == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    bool carries = false;
    const attend::Ev event = event_of(result->kind, &carries);
    if (!carries) {
        return ESP_OK;
    }
    apply(event, result, now_ms);
    return ESP_OK;
}

extern "C" esp_err_t svc_attendance_policy(svc_attendance_policy_t *out)
{
    if (out == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    *out = s_policy;
    return ESP_OK;
}

extern "C" esp_err_t svc_attendance_on_presence(bool present)
{
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    const svc_vision_result_t empty = {};
    apply(present ? attend::Ev::PresenceOn : attend::Ev::PresenceOff, &empty, s_state_since_ms);
    return ESP_OK;
}

extern "C" esp_err_t svc_attendance_note_served(uint32_t employee_id, int64_t now_ms)
{
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    s_last_employee = employee_id;
    s_last_stamp_ms = now_ms;
    s_served = true;
    s_left_since_grant = false;
    ESP_LOGI(TAG, "employee %" PRIu32 " served without a record, next grant needs an arrival",
             employee_id);
    return ESP_OK;
}

extern "C" esp_err_t svc_attendance_tick(int64_t now_ms)
{
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    const uint32_t hold_ms = hold_of(s_state);
    if (hold_ms == 0 || now_ms - s_state_since_ms < (int64_t)hold_ms) {
        return ESP_OK;
    }
    const svc_vision_result_t empty = {};
    apply(attend::Ev::Timeout, &empty, now_ms);
    return ESP_OK;
}

extern "C" svc_attendance_state_t svc_attendance_state(void)
{
    return (svc_attendance_state_t)s_state;
}

extern "C" esp_err_t svc_attendance_last_record(storage_attend_record_t *out)
{
    if (out == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_have_record) {
        return ESP_ERR_NOT_FOUND;
    }
    *out = s_last_record;
    return ESP_OK;
}

extern "C" uint32_t svc_attendance_records(void)
{
    return s_records;
}
