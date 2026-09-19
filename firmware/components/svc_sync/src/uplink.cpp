#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_log.h"
#include "gen_payload.h"
#include "uplink.hpp"

namespace uplink {

namespace {

const char *TAG = "svc_sync";

float from_q88(uint16_t raw) noexcept
{
    return (float)raw / (float)STORAGE_ATTEND_SCORE_ONE;
}

}  // namespace

esp_err_t UplinkQueue::init(const char *device_id) noexcept
{
    if (device_id == nullptr || device_id[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    strlcpy(device_id_, device_id, sizeof(device_id_));
    stats_ = {};
    storage_cursor_t at = {};
    const esp_err_t known = store_.cursor_get(&at);
    if (known != ESP_OK) {
        return known;
    }
    storage_attend_record_t rec = {};
    storage_cursor_t next = {};
    stats_.backlog = store_.read(&at, &rec, &next) == ESP_OK;
    ESP_LOGI(TAG, "uplink at file %u offset %" PRIu32 ", backlog %s", at.file_index, at.offset,
             stats_.backlog ? "yes" : "no");
    return ESP_OK;
}

bool UplinkQueue::encode(const storage_attend_record_t &rec, char *out, size_t cap) const noexcept
{
    attendance_record_t wire = {};
    strlcpy(wire.device_id, device_id_, sizeof(wire.device_id));
    snprintf(wire.local_id, sizeof(wire.local_id), "%llu", (unsigned long long)rec.local_id);
    wire.employee_id = rec.employee_id;
    wire.ts = rec.ts_ms;
    wire.direction = rec.direction == STORAGE_ATTEND_DIR_OUT ? ATTENDANCE_RECORD_DIRECTION_OUT
                                                             : ATTENDANCE_RECORD_DIRECTION_IN;
    wire.match_score = from_q88(rec.match_score);
    wire.liveness_score = from_q88(rec.liveness_score);
    wire.model_version = rec.model_version;
    wire.door_opened = (rec.flags & STORAGE_ATTEND_FLAG_DOOR) != 0;
    wire.captured_offline = (rec.flags & STORAGE_ATTEND_FLAG_OFFLINE) != 0;
    wire.clock_unsynced = (rec.flags & STORAGE_ATTEND_FLAG_NO_NTP) != 0;
    wire.has_door_opened = true;
    wire.has_captured_offline = true;
    wire.has_clock_unsynced = true;

    cJSON *root = attendance_record_to_json(&wire);
    if (root == nullptr) {
        return false;
    }
    const bool printed = cJSON_PrintPreallocated(root, out, (int)cap, 0);
    cJSON_Delete(root);
    return printed;
}

esp_err_t UplinkQueue::drain(size_t batch, uint32_t ack_timeout_ms) noexcept
{
    if (batch == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!link_.up()) {
        stats_.backlog = true;
        return ESP_ERR_INVALID_STATE;
    }
    char payload[kPayloadCap];
    for (size_t i = 0; i < batch; ++i) {
        storage_cursor_t at = {};
        const esp_err_t known = store_.cursor_get(&at);
        if (known != ESP_OK) {
            ++stats_.stalled;
            return known;
        }
        storage_attend_record_t rec = {};
        storage_cursor_t next = {};
        const esp_err_t held = store_.read(&at, &rec, &next);
        if (held == ESP_ERR_NOT_FOUND) {
            stats_.backlog = false;
            return ESP_OK;
        }
        if (held != ESP_OK) {
            ++stats_.stalled;
            return held;
        }
        if (!encode(rec, payload, sizeof(payload))) {
            // A record that cannot be written as json never will be, so moving
            // past it is the only way the ones behind it ever leave.
            ESP_LOGE(TAG, "record %llu will not encode, skipped",
                     (unsigned long long)rec.local_id);
            ++stats_.stalled;
            return store_.cursor_set(&next) == ESP_OK ? ESP_ERR_NOT_FINISHED : ESP_FAIL;
        }
        const esp_err_t sent = link_.send(payload, strlen(payload), ack_timeout_ms);
        if (sent != ESP_OK) {
            stats_.backlog = true;
            ++stats_.stalled;
            ESP_LOGW(TAG, "record %llu stays queued: %s", (unsigned long long)rec.local_id,
                     esp_err_to_name(sent));
            return sent;
        }
        // The cursor is persisted after the ack on purpose: at-least-once
        // (KEHOACH 6.2.6).
        const esp_err_t moved = store_.cursor_set(&next);
        if (moved != ESP_OK) {
            ++stats_.orphans;
            stats_.backlog = true;
            ESP_LOGE(TAG, "record %llu acked but the cursor held: %s",
                     (unsigned long long)rec.local_id, esp_err_to_name(moved));
            return moved;
        }
        ++stats_.acked;
    }
    storage_cursor_t at = {};
    storage_attend_record_t rec = {};
    storage_cursor_t next = {};
    stats_.backlog = store_.cursor_get(&at) == ESP_OK && store_.read(&at, &rec, &next) == ESP_OK;
    return stats_.backlog ? ESP_ERR_NOT_FINISHED : ESP_OK;
}

}  // namespace uplink
