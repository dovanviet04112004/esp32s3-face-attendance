// GENERATED FILE - DO NOT EDIT.
// Source: contracts/schema/
// Regenerate: ./tools/gen_contracts.py

#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "cJSON.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    ATTENDANCE_RECORD_DIRECTION_IN = 0,
    ATTENDANCE_RECORD_DIRECTION_OUT = 1,
} attendance_record_direction_t;

static inline const char *attendance_record_direction_str(attendance_record_direction_t v)
{
    switch (v) {
    case ATTENDANCE_RECORD_DIRECTION_IN: return "IN";
    case ATTENDANCE_RECORD_DIRECTION_OUT: return "OUT";
    default: return "";
    }
}

static inline bool attendance_record_direction_parse(const char *s, attendance_record_direction_t *out)
{
    if (s == NULL || out == NULL) { return false; }
    if (strcmp(s, "IN") == 0) { *out = ATTENDANCE_RECORD_DIRECTION_IN; return true; }
    if (strcmp(s, "OUT") == 0) { *out = ATTENDANCE_RECORD_DIRECTION_OUT; return true; }
    return false;
}

typedef struct {
    char device_id[33];
    char local_id[21];
    uint32_t employee_id;
    int64_t ts;
    attendance_record_direction_t direction;
    float match_score;
    float liveness_score;
    uint16_t model_version;
    bool door_opened;
    bool captured_offline;
    bool clock_unsynced;
    bool has_door_opened;
    bool has_captured_offline;
    bool has_clock_unsynced;
} attendance_record_t;

static inline bool attendance_record_from_json(const cJSON *root, attendance_record_t *out)
{
    if (root == NULL || out == NULL) { return false; }
    memset(out, 0, sizeof(*out));
    const cJSON *item = NULL;
    item = cJSON_GetObjectItemCaseSensitive(root, "deviceId");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->device_id, item->valuestring, sizeof(out->device_id) - 1);
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "localId");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->local_id, item->valuestring, sizeof(out->local_id) - 1);
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "employeeId");
    if (cJSON_IsNumber(item)) {
        out->employee_id = (uint32_t) item->valuedouble;
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "ts");
    if (cJSON_IsNumber(item)) {
        out->ts = (int64_t) item->valuedouble;
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "direction");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        if (!attendance_record_direction_parse(item->valuestring, &out->direction)) { return false; }
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "matchScore");
    if (cJSON_IsNumber(item)) {
        out->match_score = (float) item->valuedouble;
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "livenessScore");
    if (cJSON_IsNumber(item)) {
        out->liveness_score = (float) item->valuedouble;
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "modelVersion");
    if (cJSON_IsNumber(item)) {
        out->model_version = (uint16_t) item->valuedouble;
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "doorOpened");
    if (cJSON_IsBool(item)) {
        out->door_opened = cJSON_IsTrue(item);
        out->has_door_opened = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "capturedOffline");
    if (cJSON_IsBool(item)) {
        out->captured_offline = cJSON_IsTrue(item);
        out->has_captured_offline = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "clockUnsynced");
    if (cJSON_IsBool(item)) {
        out->clock_unsynced = cJSON_IsTrue(item);
        out->has_clock_unsynced = true;
    }
    return true;
}

static inline cJSON *attendance_record_to_json(const attendance_record_t *in)
{
    if (in == NULL) { return NULL; }
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) { return NULL; }
    cJSON_AddStringToObject(root, "deviceId", in->device_id);
    cJSON_AddStringToObject(root, "localId", in->local_id);
    cJSON_AddNumberToObject(root, "employeeId", (double) in->employee_id);
    cJSON_AddNumberToObject(root, "ts", (double) in->ts);
    cJSON_AddStringToObject(root, "direction", attendance_record_direction_str(in->direction));
    cJSON_AddNumberToObject(root, "matchScore", (double) in->match_score);
    cJSON_AddNumberToObject(root, "livenessScore", (double) in->liveness_score);
    cJSON_AddNumberToObject(root, "modelVersion", (double) in->model_version);
    if (in->has_door_opened) {
        cJSON_AddBoolToObject(root, "doorOpened", in->door_opened);
    }
    if (in->has_captured_offline) {
        cJSON_AddBoolToObject(root, "capturedOffline", in->captured_offline);
    }
    if (in->has_clock_unsynced) {
        cJSON_AddBoolToObject(root, "clockUnsynced", in->clock_unsynced);
    }
    return root;
}

typedef enum {
    DEVICE_COMMAND_CONFIG_LANG_VI = 0,
    DEVICE_COMMAND_CONFIG_LANG_EN = 1,
} device_command_config_lang_t;

static inline const char *device_command_config_lang_str(device_command_config_lang_t v)
{
    switch (v) {
    case DEVICE_COMMAND_CONFIG_LANG_VI: return "vi";
    case DEVICE_COMMAND_CONFIG_LANG_EN: return "en";
    default: return "";
    }
}

static inline bool device_command_config_lang_parse(const char *s, device_command_config_lang_t *out)
{
    if (s == NULL || out == NULL) { return false; }
    if (strcmp(s, "vi") == 0) { *out = DEVICE_COMMAND_CONFIG_LANG_VI; return true; }
    if (strcmp(s, "en") == 0) { *out = DEVICE_COMMAND_CONFIG_LANG_EN; return true; }
    return false;
}

typedef struct {
    uint8_t brightness;
    uint8_t volume;
    device_command_config_lang_t lang;
    float detect_threshold;
    float match_threshold;
    float liveness_threshold;
    uint16_t dedup_window_minutes;
    uint8_t wake_distance_cm;
    bool has_brightness;
    bool has_volume;
    bool has_lang;
    bool has_detect_threshold;
    bool has_match_threshold;
    bool has_liveness_threshold;
    bool has_dedup_window_minutes;
    bool has_wake_distance_cm;
} device_command_config_t;

static inline bool device_command_config_from_json(const cJSON *root, device_command_config_t *out)
{
    if (root == NULL || out == NULL) { return false; }
    memset(out, 0, sizeof(*out));
    const cJSON *item = NULL;
    item = cJSON_GetObjectItemCaseSensitive(root, "brightness");
    if (cJSON_IsNumber(item)) {
        out->brightness = (uint8_t) item->valuedouble;
        out->has_brightness = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "volume");
    if (cJSON_IsNumber(item)) {
        out->volume = (uint8_t) item->valuedouble;
        out->has_volume = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "lang");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        if (!device_command_config_lang_parse(item->valuestring, &out->lang)) { return false; }
        out->has_lang = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "detectThreshold");
    if (cJSON_IsNumber(item)) {
        out->detect_threshold = (float) item->valuedouble;
        out->has_detect_threshold = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "matchThreshold");
    if (cJSON_IsNumber(item)) {
        out->match_threshold = (float) item->valuedouble;
        out->has_match_threshold = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "livenessThreshold");
    if (cJSON_IsNumber(item)) {
        out->liveness_threshold = (float) item->valuedouble;
        out->has_liveness_threshold = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "dedupWindowMinutes");
    if (cJSON_IsNumber(item)) {
        out->dedup_window_minutes = (uint16_t) item->valuedouble;
        out->has_dedup_window_minutes = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "wakeDistanceCm");
    if (cJSON_IsNumber(item)) {
        out->wake_distance_cm = (uint8_t) item->valuedouble;
        out->has_wake_distance_cm = true;
    }
    return true;
}

static inline cJSON *device_command_config_to_json(const device_command_config_t *in)
{
    if (in == NULL) { return NULL; }
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) { return NULL; }
    if (in->has_brightness) {
        cJSON_AddNumberToObject(root, "brightness", (double) in->brightness);
    }
    if (in->has_volume) {
        cJSON_AddNumberToObject(root, "volume", (double) in->volume);
    }
    if (in->has_lang) {
        cJSON_AddStringToObject(root, "lang", device_command_config_lang_str(in->lang));
    }
    if (in->has_detect_threshold) {
        cJSON_AddNumberToObject(root, "detectThreshold", (double) in->detect_threshold);
    }
    if (in->has_match_threshold) {
        cJSON_AddNumberToObject(root, "matchThreshold", (double) in->match_threshold);
    }
    if (in->has_liveness_threshold) {
        cJSON_AddNumberToObject(root, "livenessThreshold", (double) in->liveness_threshold);
    }
    if (in->has_dedup_window_minutes) {
        cJSON_AddNumberToObject(root, "dedupWindowMinutes", (double) in->dedup_window_minutes);
    }
    if (in->has_wake_distance_cm) {
        cJSON_AddNumberToObject(root, "wakeDistanceCm", (double) in->wake_distance_cm);
    }
    return root;
}

typedef enum {
    DEVICE_COMMAND_ACTION_OPEN_DOOR = 0,
    DEVICE_COMMAND_ACTION_REBOOT = 1,
    DEVICE_COMMAND_ACTION_SET_CONFIG = 2,
    DEVICE_COMMAND_ACTION_SYNC_TIME = 3,
    DEVICE_COMMAND_ACTION_RELOAD_FACEDB = 4,
    DEVICE_COMMAND_ACTION_ROTATE_TOKEN = 5,
    DEVICE_COMMAND_ACTION_CLEAR_LOGS = 6,
    DEVICE_COMMAND_ACTION_SET_ACTIVE_SLOT = 7,
    DEVICE_COMMAND_ACTION_DIAGNOSTICS = 8,
} device_command_action_t;

static inline const char *device_command_action_str(device_command_action_t v)
{
    switch (v) {
    case DEVICE_COMMAND_ACTION_OPEN_DOOR: return "OPEN_DOOR";
    case DEVICE_COMMAND_ACTION_REBOOT: return "REBOOT";
    case DEVICE_COMMAND_ACTION_SET_CONFIG: return "SET_CONFIG";
    case DEVICE_COMMAND_ACTION_SYNC_TIME: return "SYNC_TIME";
    case DEVICE_COMMAND_ACTION_RELOAD_FACEDB: return "RELOAD_FACEDB";
    case DEVICE_COMMAND_ACTION_ROTATE_TOKEN: return "ROTATE_TOKEN";
    case DEVICE_COMMAND_ACTION_CLEAR_LOGS: return "CLEAR_LOGS";
    case DEVICE_COMMAND_ACTION_SET_ACTIVE_SLOT: return "SET_ACTIVE_SLOT";
    case DEVICE_COMMAND_ACTION_DIAGNOSTICS: return "DIAGNOSTICS";
    default: return "";
    }
}

static inline bool device_command_action_parse(const char *s, device_command_action_t *out)
{
    if (s == NULL || out == NULL) { return false; }
    if (strcmp(s, "OPEN_DOOR") == 0) { *out = DEVICE_COMMAND_ACTION_OPEN_DOOR; return true; }
    if (strcmp(s, "REBOOT") == 0) { *out = DEVICE_COMMAND_ACTION_REBOOT; return true; }
    if (strcmp(s, "SET_CONFIG") == 0) { *out = DEVICE_COMMAND_ACTION_SET_CONFIG; return true; }
    if (strcmp(s, "SYNC_TIME") == 0) { *out = DEVICE_COMMAND_ACTION_SYNC_TIME; return true; }
    if (strcmp(s, "RELOAD_FACEDB") == 0) { *out = DEVICE_COMMAND_ACTION_RELOAD_FACEDB; return true; }
    if (strcmp(s, "ROTATE_TOKEN") == 0) { *out = DEVICE_COMMAND_ACTION_ROTATE_TOKEN; return true; }
    if (strcmp(s, "CLEAR_LOGS") == 0) { *out = DEVICE_COMMAND_ACTION_CLEAR_LOGS; return true; }
    if (strcmp(s, "SET_ACTIVE_SLOT") == 0) { *out = DEVICE_COMMAND_ACTION_SET_ACTIVE_SLOT; return true; }
    if (strcmp(s, "DIAGNOSTICS") == 0) { *out = DEVICE_COMMAND_ACTION_DIAGNOSTICS; return true; }
    return false;
}

typedef struct {
    char cmd_id[37];
    int64_t ts;
    int64_t expires_at;
    device_command_action_t action;
    char issued_by[65];
    uint16_t open_ms;
    uint8_t active_slot;
    device_command_config_t config;
    bool has_expires_at;
    bool has_issued_by;
    bool has_open_ms;
    bool has_active_slot;
    bool has_config;
} device_command_t;

static inline bool device_command_from_json(const cJSON *root, device_command_t *out)
{
    if (root == NULL || out == NULL) { return false; }
    memset(out, 0, sizeof(*out));
    const cJSON *item = NULL;
    item = cJSON_GetObjectItemCaseSensitive(root, "cmdId");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->cmd_id, item->valuestring, sizeof(out->cmd_id) - 1);
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "ts");
    if (cJSON_IsNumber(item)) {
        out->ts = (int64_t) item->valuedouble;
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "expiresAt");
    if (cJSON_IsNumber(item)) {
        out->expires_at = (int64_t) item->valuedouble;
        out->has_expires_at = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "action");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        if (!device_command_action_parse(item->valuestring, &out->action)) { return false; }
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "issuedBy");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->issued_by, item->valuestring, sizeof(out->issued_by) - 1);
        out->has_issued_by = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "openMs");
    if (cJSON_IsNumber(item)) {
        out->open_ms = (uint16_t) item->valuedouble;
        out->has_open_ms = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "activeSlot");
    if (cJSON_IsNumber(item)) {
        out->active_slot = (uint8_t) item->valuedouble;
        out->has_active_slot = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "config");
    if (cJSON_IsObject(item)) {
        if (!device_command_config_from_json(item, &out->config)) { return false; }
        out->has_config = true;
    }
    return true;
}

static inline cJSON *device_command_to_json(const device_command_t *in)
{
    if (in == NULL) { return NULL; }
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) { return NULL; }
    cJSON_AddStringToObject(root, "cmdId", in->cmd_id);
    cJSON_AddNumberToObject(root, "ts", (double) in->ts);
    if (in->has_expires_at) {
        cJSON_AddNumberToObject(root, "expiresAt", (double) in->expires_at);
    }
    cJSON_AddStringToObject(root, "action", device_command_action_str(in->action));
    if (in->has_issued_by) {
        cJSON_AddStringToObject(root, "issuedBy", in->issued_by);
    }
    if (in->has_open_ms) {
        cJSON_AddNumberToObject(root, "openMs", (double) in->open_ms);
    }
    if (in->has_active_slot) {
        cJSON_AddNumberToObject(root, "activeSlot", (double) in->active_slot);
    }
    if (in->has_config) {
        cJSON_AddItemToObject(root, "config", device_command_config_to_json(&in->config));
    }
    return root;
}

typedef enum {
    DEVICE_EVENT_TYPE_SPOOF_DETECTED = 0,
    DEVICE_EVENT_TYPE_UNKNOWN_FACE = 1,
    DEVICE_EVENT_TYPE_QUALITY_REJECTED = 2,
    DEVICE_EVENT_TYPE_DOOR_OPENED_MANUALLY = 3,
    DEVICE_EVENT_TYPE_DOOR_FAULT = 4,
    DEVICE_EVENT_TYPE_CAMERA_FAULT = 5,
    DEVICE_EVENT_TYPE_TOF_FAULT = 6,
    DEVICE_EVENT_TYPE_LCD_FAULT = 7,
    DEVICE_EVENT_TYPE_AUDIO_FAULT = 8,
    DEVICE_EVENT_TYPE_STORAGE_FAULT = 9,
    DEVICE_EVENT_TYPE_FACEDB_CORRUPT = 10,
    DEVICE_EVENT_TYPE_MODEL_LOAD_FAILED = 11,
    DEVICE_EVENT_TYPE_OTA_FAILED = 12,
    DEVICE_EVENT_TYPE_OTA_ROLLED_BACK = 13,
    DEVICE_EVENT_TYPE_TIME_UNSYNCED = 14,
    DEVICE_EVENT_TYPE_BOOTED = 15,
} device_event_type_t;

static inline const char *device_event_type_str(device_event_type_t v)
{
    switch (v) {
    case DEVICE_EVENT_TYPE_SPOOF_DETECTED: return "SPOOF_DETECTED";
    case DEVICE_EVENT_TYPE_UNKNOWN_FACE: return "UNKNOWN_FACE";
    case DEVICE_EVENT_TYPE_QUALITY_REJECTED: return "QUALITY_REJECTED";
    case DEVICE_EVENT_TYPE_DOOR_OPENED_MANUALLY: return "DOOR_OPENED_MANUALLY";
    case DEVICE_EVENT_TYPE_DOOR_FAULT: return "DOOR_FAULT";
    case DEVICE_EVENT_TYPE_CAMERA_FAULT: return "CAMERA_FAULT";
    case DEVICE_EVENT_TYPE_TOF_FAULT: return "TOF_FAULT";
    case DEVICE_EVENT_TYPE_LCD_FAULT: return "LCD_FAULT";
    case DEVICE_EVENT_TYPE_AUDIO_FAULT: return "AUDIO_FAULT";
    case DEVICE_EVENT_TYPE_STORAGE_FAULT: return "STORAGE_FAULT";
    case DEVICE_EVENT_TYPE_FACEDB_CORRUPT: return "FACEDB_CORRUPT";
    case DEVICE_EVENT_TYPE_MODEL_LOAD_FAILED: return "MODEL_LOAD_FAILED";
    case DEVICE_EVENT_TYPE_OTA_FAILED: return "OTA_FAILED";
    case DEVICE_EVENT_TYPE_OTA_ROLLED_BACK: return "OTA_ROLLED_BACK";
    case DEVICE_EVENT_TYPE_TIME_UNSYNCED: return "TIME_UNSYNCED";
    case DEVICE_EVENT_TYPE_BOOTED: return "BOOTED";
    default: return "";
    }
}

static inline bool device_event_type_parse(const char *s, device_event_type_t *out)
{
    if (s == NULL || out == NULL) { return false; }
    if (strcmp(s, "SPOOF_DETECTED") == 0) { *out = DEVICE_EVENT_TYPE_SPOOF_DETECTED; return true; }
    if (strcmp(s, "UNKNOWN_FACE") == 0) { *out = DEVICE_EVENT_TYPE_UNKNOWN_FACE; return true; }
    if (strcmp(s, "QUALITY_REJECTED") == 0) { *out = DEVICE_EVENT_TYPE_QUALITY_REJECTED; return true; }
    if (strcmp(s, "DOOR_OPENED_MANUALLY") == 0) { *out = DEVICE_EVENT_TYPE_DOOR_OPENED_MANUALLY; return true; }
    if (strcmp(s, "DOOR_FAULT") == 0) { *out = DEVICE_EVENT_TYPE_DOOR_FAULT; return true; }
    if (strcmp(s, "CAMERA_FAULT") == 0) { *out = DEVICE_EVENT_TYPE_CAMERA_FAULT; return true; }
    if (strcmp(s, "TOF_FAULT") == 0) { *out = DEVICE_EVENT_TYPE_TOF_FAULT; return true; }
    if (strcmp(s, "LCD_FAULT") == 0) { *out = DEVICE_EVENT_TYPE_LCD_FAULT; return true; }
    if (strcmp(s, "AUDIO_FAULT") == 0) { *out = DEVICE_EVENT_TYPE_AUDIO_FAULT; return true; }
    if (strcmp(s, "STORAGE_FAULT") == 0) { *out = DEVICE_EVENT_TYPE_STORAGE_FAULT; return true; }
    if (strcmp(s, "FACEDB_CORRUPT") == 0) { *out = DEVICE_EVENT_TYPE_FACEDB_CORRUPT; return true; }
    if (strcmp(s, "MODEL_LOAD_FAILED") == 0) { *out = DEVICE_EVENT_TYPE_MODEL_LOAD_FAILED; return true; }
    if (strcmp(s, "OTA_FAILED") == 0) { *out = DEVICE_EVENT_TYPE_OTA_FAILED; return true; }
    if (strcmp(s, "OTA_ROLLED_BACK") == 0) { *out = DEVICE_EVENT_TYPE_OTA_ROLLED_BACK; return true; }
    if (strcmp(s, "TIME_UNSYNCED") == 0) { *out = DEVICE_EVENT_TYPE_TIME_UNSYNCED; return true; }
    if (strcmp(s, "BOOTED") == 0) { *out = DEVICE_EVENT_TYPE_BOOTED; return true; }
    return false;
}

typedef enum {
    DEVICE_EVENT_SEVERITY_INFO = 0,
    DEVICE_EVENT_SEVERITY_WARN = 1,
    DEVICE_EVENT_SEVERITY_ERROR = 2,
} device_event_severity_t;

static inline const char *device_event_severity_str(device_event_severity_t v)
{
    switch (v) {
    case DEVICE_EVENT_SEVERITY_INFO: return "INFO";
    case DEVICE_EVENT_SEVERITY_WARN: return "WARN";
    case DEVICE_EVENT_SEVERITY_ERROR: return "ERROR";
    default: return "";
    }
}

static inline bool device_event_severity_parse(const char *s, device_event_severity_t *out)
{
    if (s == NULL || out == NULL) { return false; }
    if (strcmp(s, "INFO") == 0) { *out = DEVICE_EVENT_SEVERITY_INFO; return true; }
    if (strcmp(s, "WARN") == 0) { *out = DEVICE_EVENT_SEVERITY_WARN; return true; }
    if (strcmp(s, "ERROR") == 0) { *out = DEVICE_EVENT_SEVERITY_ERROR; return true; }
    return false;
}

typedef struct {
    char device_id[33];
    int64_t ts;
    device_event_type_t type;
    device_event_severity_t severity;
    char message[201];
    uint32_t employee_id;
    float liveness_score;
    int64_t error_code;
    bool has_message;
    bool has_employee_id;
    bool has_liveness_score;
    bool has_error_code;
} device_event_t;

static inline bool device_event_from_json(const cJSON *root, device_event_t *out)
{
    if (root == NULL || out == NULL) { return false; }
    memset(out, 0, sizeof(*out));
    const cJSON *item = NULL;
    item = cJSON_GetObjectItemCaseSensitive(root, "deviceId");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->device_id, item->valuestring, sizeof(out->device_id) - 1);
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "ts");
    if (cJSON_IsNumber(item)) {
        out->ts = (int64_t) item->valuedouble;
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "type");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        if (!device_event_type_parse(item->valuestring, &out->type)) { return false; }
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "severity");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        if (!device_event_severity_parse(item->valuestring, &out->severity)) { return false; }
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "message");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->message, item->valuestring, sizeof(out->message) - 1);
        out->has_message = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "employeeId");
    if (cJSON_IsNumber(item)) {
        out->employee_id = (uint32_t) item->valuedouble;
        out->has_employee_id = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "livenessScore");
    if (cJSON_IsNumber(item)) {
        out->liveness_score = (float) item->valuedouble;
        out->has_liveness_score = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "errorCode");
    if (cJSON_IsNumber(item)) {
        out->error_code = (int64_t) item->valuedouble;
        out->has_error_code = true;
    }
    return true;
}

static inline cJSON *device_event_to_json(const device_event_t *in)
{
    if (in == NULL) { return NULL; }
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) { return NULL; }
    cJSON_AddStringToObject(root, "deviceId", in->device_id);
    cJSON_AddNumberToObject(root, "ts", (double) in->ts);
    cJSON_AddStringToObject(root, "type", device_event_type_str(in->type));
    cJSON_AddStringToObject(root, "severity", device_event_severity_str(in->severity));
    if (in->has_message) {
        cJSON_AddStringToObject(root, "message", in->message);
    }
    if (in->has_employee_id) {
        cJSON_AddNumberToObject(root, "employeeId", (double) in->employee_id);
    }
    if (in->has_liveness_score) {
        cJSON_AddNumberToObject(root, "livenessScore", (double) in->liveness_score);
    }
    if (in->has_error_code) {
        cJSON_AddNumberToObject(root, "errorCode", (double) in->error_code);
    }
    return root;
}

typedef enum {
    ENROLL_PAYLOAD_OP_UPSERT = 0,
    ENROLL_PAYLOAD_OP_DELETE = 1,
    ENROLL_PAYLOAD_OP_DELETE_EMPLOYEE = 2,
    ENROLL_PAYLOAD_OP_REPLACE_ALL = 3,
} enroll_payload_op_t;

static inline const char *enroll_payload_op_str(enroll_payload_op_t v)
{
    switch (v) {
    case ENROLL_PAYLOAD_OP_UPSERT: return "UPSERT";
    case ENROLL_PAYLOAD_OP_DELETE: return "DELETE";
    case ENROLL_PAYLOAD_OP_DELETE_EMPLOYEE: return "DELETE_EMPLOYEE";
    case ENROLL_PAYLOAD_OP_REPLACE_ALL: return "REPLACE_ALL";
    default: return "";
    }
}

static inline bool enroll_payload_op_parse(const char *s, enroll_payload_op_t *out)
{
    if (s == NULL || out == NULL) { return false; }
    if (strcmp(s, "UPSERT") == 0) { *out = ENROLL_PAYLOAD_OP_UPSERT; return true; }
    if (strcmp(s, "DELETE") == 0) { *out = ENROLL_PAYLOAD_OP_DELETE; return true; }
    if (strcmp(s, "DELETE_EMPLOYEE") == 0) { *out = ENROLL_PAYLOAD_OP_DELETE_EMPLOYEE; return true; }
    if (strcmp(s, "REPLACE_ALL") == 0) { *out = ENROLL_PAYLOAD_OP_REPLACE_ALL; return true; }
    return false;
}

typedef struct {
    enroll_payload_op_t op;
    uint32_t employee_id;
    uint16_t template_idx;
    int64_t updated_at;
    char embedding[685];
    float scale;
    uint8_t quality;
    char embedding_version[33];
    char full_name[65];
    char employee_code[33];
    bool has_embedding;
    bool has_scale;
    bool has_quality;
    bool has_embedding_version;
    bool has_full_name;
    bool has_employee_code;
} enroll_payload_t;

static inline bool enroll_payload_from_json(const cJSON *root, enroll_payload_t *out)
{
    if (root == NULL || out == NULL) { return false; }
    memset(out, 0, sizeof(*out));
    const cJSON *item = NULL;
    item = cJSON_GetObjectItemCaseSensitive(root, "op");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        if (!enroll_payload_op_parse(item->valuestring, &out->op)) { return false; }
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "employeeId");
    if (cJSON_IsNumber(item)) {
        out->employee_id = (uint32_t) item->valuedouble;
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "templateIdx");
    if (cJSON_IsNumber(item)) {
        out->template_idx = (uint16_t) item->valuedouble;
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "updatedAt");
    if (cJSON_IsNumber(item)) {
        out->updated_at = (int64_t) item->valuedouble;
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "embedding");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->embedding, item->valuestring, sizeof(out->embedding) - 1);
        out->has_embedding = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "scale");
    if (cJSON_IsNumber(item)) {
        out->scale = (float) item->valuedouble;
        out->has_scale = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "quality");
    if (cJSON_IsNumber(item)) {
        out->quality = (uint8_t) item->valuedouble;
        out->has_quality = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "embeddingVersion");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->embedding_version, item->valuestring, sizeof(out->embedding_version) - 1);
        out->has_embedding_version = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "fullName");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->full_name, item->valuestring, sizeof(out->full_name) - 1);
        out->has_full_name = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "employeeCode");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->employee_code, item->valuestring, sizeof(out->employee_code) - 1);
        out->has_employee_code = true;
    }
    return true;
}

static inline cJSON *enroll_payload_to_json(const enroll_payload_t *in)
{
    if (in == NULL) { return NULL; }
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) { return NULL; }
    cJSON_AddStringToObject(root, "op", enroll_payload_op_str(in->op));
    cJSON_AddNumberToObject(root, "employeeId", (double) in->employee_id);
    cJSON_AddNumberToObject(root, "templateIdx", (double) in->template_idx);
    cJSON_AddNumberToObject(root, "updatedAt", (double) in->updated_at);
    if (in->has_embedding) {
        cJSON_AddStringToObject(root, "embedding", in->embedding);
    }
    if (in->has_scale) {
        cJSON_AddNumberToObject(root, "scale", (double) in->scale);
    }
    if (in->has_quality) {
        cJSON_AddNumberToObject(root, "quality", (double) in->quality);
    }
    if (in->has_embedding_version) {
        cJSON_AddStringToObject(root, "embeddingVersion", in->embedding_version);
    }
    if (in->has_full_name) {
        cJSON_AddStringToObject(root, "fullName", in->full_name);
    }
    if (in->has_employee_code) {
        cJSON_AddStringToObject(root, "employeeCode", in->employee_code);
    }
    return root;
}

typedef struct {
    char device_id[33];
    int64_t ts;
    int64_t uptime_seconds;
    char fw_version[33];
    char model_version[33];
    int64_t rssi_dbm;
    int64_t heap_free_bytes;
    int64_t heap_min_free_bytes;
    int64_t psram_free_bytes;
    int64_t pending_uplink_count;
    uint8_t active_slot;
    int64_t boot_count;
    bool has_rssi_dbm;
    bool has_heap_free_bytes;
    bool has_heap_min_free_bytes;
    bool has_psram_free_bytes;
    bool has_pending_uplink_count;
    bool has_active_slot;
    bool has_boot_count;
} heartbeat_t;

static inline bool heartbeat_from_json(const cJSON *root, heartbeat_t *out)
{
    if (root == NULL || out == NULL) { return false; }
    memset(out, 0, sizeof(*out));
    const cJSON *item = NULL;
    item = cJSON_GetObjectItemCaseSensitive(root, "deviceId");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->device_id, item->valuestring, sizeof(out->device_id) - 1);
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "ts");
    if (cJSON_IsNumber(item)) {
        out->ts = (int64_t) item->valuedouble;
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "uptimeSeconds");
    if (cJSON_IsNumber(item)) {
        out->uptime_seconds = (int64_t) item->valuedouble;
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "fwVersion");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->fw_version, item->valuestring, sizeof(out->fw_version) - 1);
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "modelVersion");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->model_version, item->valuestring, sizeof(out->model_version) - 1);
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "rssiDbm");
    if (cJSON_IsNumber(item)) {
        out->rssi_dbm = (int64_t) item->valuedouble;
        out->has_rssi_dbm = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "heapFreeBytes");
    if (cJSON_IsNumber(item)) {
        out->heap_free_bytes = (int64_t) item->valuedouble;
        out->has_heap_free_bytes = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "heapMinFreeBytes");
    if (cJSON_IsNumber(item)) {
        out->heap_min_free_bytes = (int64_t) item->valuedouble;
        out->has_heap_min_free_bytes = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "psramFreeBytes");
    if (cJSON_IsNumber(item)) {
        out->psram_free_bytes = (int64_t) item->valuedouble;
        out->has_psram_free_bytes = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "pendingUplinkCount");
    if (cJSON_IsNumber(item)) {
        out->pending_uplink_count = (int64_t) item->valuedouble;
        out->has_pending_uplink_count = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "activeSlot");
    if (cJSON_IsNumber(item)) {
        out->active_slot = (uint8_t) item->valuedouble;
        out->has_active_slot = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "bootCount");
    if (cJSON_IsNumber(item)) {
        out->boot_count = (int64_t) item->valuedouble;
        out->has_boot_count = true;
    }
    return true;
}

static inline cJSON *heartbeat_to_json(const heartbeat_t *in)
{
    if (in == NULL) { return NULL; }
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) { return NULL; }
    cJSON_AddStringToObject(root, "deviceId", in->device_id);
    cJSON_AddNumberToObject(root, "ts", (double) in->ts);
    cJSON_AddNumberToObject(root, "uptimeSeconds", (double) in->uptime_seconds);
    cJSON_AddStringToObject(root, "fwVersion", in->fw_version);
    cJSON_AddStringToObject(root, "modelVersion", in->model_version);
    if (in->has_rssi_dbm) {
        cJSON_AddNumberToObject(root, "rssiDbm", (double) in->rssi_dbm);
    }
    if (in->has_heap_free_bytes) {
        cJSON_AddNumberToObject(root, "heapFreeBytes", (double) in->heap_free_bytes);
    }
    if (in->has_heap_min_free_bytes) {
        cJSON_AddNumberToObject(root, "heapMinFreeBytes", (double) in->heap_min_free_bytes);
    }
    if (in->has_psram_free_bytes) {
        cJSON_AddNumberToObject(root, "psramFreeBytes", (double) in->psram_free_bytes);
    }
    if (in->has_pending_uplink_count) {
        cJSON_AddNumberToObject(root, "pendingUplinkCount", (double) in->pending_uplink_count);
    }
    if (in->has_active_slot) {
        cJSON_AddNumberToObject(root, "activeSlot", (double) in->active_slot);
    }
    if (in->has_boot_count) {
        cJSON_AddNumberToObject(root, "bootCount", (double) in->boot_count);
    }
    return root;
}

typedef enum {
    OTA_MANIFEST_TARGET_FIRMWARE = 0,
    OTA_MANIFEST_TARGET_MODELS = 1,
    OTA_MANIFEST_TARGET_ASSETS = 2,
} ota_manifest_target_t;

static inline const char *ota_manifest_target_str(ota_manifest_target_t v)
{
    switch (v) {
    case OTA_MANIFEST_TARGET_FIRMWARE: return "FIRMWARE";
    case OTA_MANIFEST_TARGET_MODELS: return "MODELS";
    case OTA_MANIFEST_TARGET_ASSETS: return "ASSETS";
    default: return "";
    }
}

static inline bool ota_manifest_target_parse(const char *s, ota_manifest_target_t *out)
{
    if (s == NULL || out == NULL) { return false; }
    if (strcmp(s, "FIRMWARE") == 0) { *out = OTA_MANIFEST_TARGET_FIRMWARE; return true; }
    if (strcmp(s, "MODELS") == 0) { *out = OTA_MANIFEST_TARGET_MODELS; return true; }
    if (strcmp(s, "ASSETS") == 0) { *out = OTA_MANIFEST_TARGET_ASSETS; return true; }
    return false;
}

typedef struct {
    char release_id[37];
    ota_manifest_target_t target;
    char version[33];
    char url[513];
    char sha256[65];
    int64_t size_bytes;
    char signature[1025];
    char min_fw_version[33];
    char run_id[129];
    bool forced;
    bool has_signature;
    bool has_min_fw_version;
    bool has_run_id;
    bool has_forced;
} ota_manifest_t;

static inline bool ota_manifest_from_json(const cJSON *root, ota_manifest_t *out)
{
    if (root == NULL || out == NULL) { return false; }
    memset(out, 0, sizeof(*out));
    const cJSON *item = NULL;
    item = cJSON_GetObjectItemCaseSensitive(root, "releaseId");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->release_id, item->valuestring, sizeof(out->release_id) - 1);
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "target");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        if (!ota_manifest_target_parse(item->valuestring, &out->target)) { return false; }
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "version");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->version, item->valuestring, sizeof(out->version) - 1);
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "url");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->url, item->valuestring, sizeof(out->url) - 1);
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "sha256");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->sha256, item->valuestring, sizeof(out->sha256) - 1);
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "sizeBytes");
    if (cJSON_IsNumber(item)) {
        out->size_bytes = (int64_t) item->valuedouble;
    } else {
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "signature");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->signature, item->valuestring, sizeof(out->signature) - 1);
        out->has_signature = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "minFwVersion");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->min_fw_version, item->valuestring, sizeof(out->min_fw_version) - 1);
        out->has_min_fw_version = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "runId");
    if (cJSON_IsString(item) && item->valuestring != NULL) {
        strncpy(out->run_id, item->valuestring, sizeof(out->run_id) - 1);
        out->has_run_id = true;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "forced");
    if (cJSON_IsBool(item)) {
        out->forced = cJSON_IsTrue(item);
        out->has_forced = true;
    }
    return true;
}

static inline cJSON *ota_manifest_to_json(const ota_manifest_t *in)
{
    if (in == NULL) { return NULL; }
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) { return NULL; }
    cJSON_AddStringToObject(root, "releaseId", in->release_id);
    cJSON_AddStringToObject(root, "target", ota_manifest_target_str(in->target));
    cJSON_AddStringToObject(root, "version", in->version);
    cJSON_AddStringToObject(root, "url", in->url);
    cJSON_AddStringToObject(root, "sha256", in->sha256);
    cJSON_AddNumberToObject(root, "sizeBytes", (double) in->size_bytes);
    if (in->has_signature) {
        cJSON_AddStringToObject(root, "signature", in->signature);
    }
    if (in->has_min_fw_version) {
        cJSON_AddStringToObject(root, "minFwVersion", in->min_fw_version);
    }
    if (in->has_run_id) {
        cJSON_AddStringToObject(root, "runId", in->run_id);
    }
    if (in->has_forced) {
        cJSON_AddBoolToObject(root, "forced", in->forced);
    }
    return root;
}

#ifdef __cplusplus
}
#endif
