// GENERATED FILE - DO NOT EDIT.
// Source: contracts/mqtt_topics.yaml
// Regenerate: ./tools/gen_contracts.py

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GEN_TOPIC_DEVICE_ID_MAX 32
#define GEN_TOPIC_MAX_LEN 53

typedef enum {
    GEN_TOPIC_ATTENDANCE = 0,
    GEN_TOPIC_HEARTBEAT = 1,
    GEN_TOPIC_EVENT = 2,
    GEN_TOPIC_STATUS = 3,
    GEN_TOPIC_CMD = 4,
    GEN_TOPIC_ENROLL = 5,
    GEN_TOPIC_OTA = 6,
    GEN_TOPIC_NONE = 7,
} gen_topic_id_t;

#define GEN_TOPIC_ATTENDANCE_QOS 1
#define GEN_TOPIC_ATTENDANCE_RETAIN false
#define GEN_TOPIC_ATTENDANCE_IS_LAST_WILL false
#define GEN_TOPIC_HEARTBEAT_QOS 0
#define GEN_TOPIC_HEARTBEAT_RETAIN true
#define GEN_TOPIC_HEARTBEAT_IS_LAST_WILL false
#define GEN_TOPIC_EVENT_QOS 1
#define GEN_TOPIC_EVENT_RETAIN false
#define GEN_TOPIC_EVENT_IS_LAST_WILL false
#define GEN_TOPIC_STATUS_QOS 1
#define GEN_TOPIC_STATUS_RETAIN true
#define GEN_TOPIC_STATUS_IS_LAST_WILL true
#define GEN_TOPIC_CMD_QOS 1
#define GEN_TOPIC_CMD_RETAIN false
#define GEN_TOPIC_CMD_IS_LAST_WILL false
#define GEN_TOPIC_ENROLL_QOS 1
#define GEN_TOPIC_ENROLL_RETAIN false
#define GEN_TOPIC_ENROLL_IS_LAST_WILL false
#define GEN_TOPIC_OTA_QOS 1
#define GEN_TOPIC_OTA_RETAIN false
#define GEN_TOPIC_OTA_IS_LAST_WILL false

static inline bool gen_topic_attendance(const char *device_id, char *out, size_t cap)
{
    if (device_id == NULL || out == NULL) { return false; }
    const size_t id_len = strlen(device_id);
    if (id_len == 0 || id_len > GEN_TOPIC_DEVICE_ID_MAX) { return false; }
    const size_t need = 6 + id_len + 14 + 1;
    if (cap < need) { return false; }
    memcpy(out, "kiosk/", 6);
    memcpy(out + 6, device_id, id_len);
    memcpy(out + 6 + id_len, "/up/attendance", 14 + 1);
    return true;
}

static inline bool gen_topic_heartbeat(const char *device_id, char *out, size_t cap)
{
    if (device_id == NULL || out == NULL) { return false; }
    const size_t id_len = strlen(device_id);
    if (id_len == 0 || id_len > GEN_TOPIC_DEVICE_ID_MAX) { return false; }
    const size_t need = 6 + id_len + 13 + 1;
    if (cap < need) { return false; }
    memcpy(out, "kiosk/", 6);
    memcpy(out + 6, device_id, id_len);
    memcpy(out + 6 + id_len, "/up/heartbeat", 13 + 1);
    return true;
}

static inline bool gen_topic_event(const char *device_id, char *out, size_t cap)
{
    if (device_id == NULL || out == NULL) { return false; }
    const size_t id_len = strlen(device_id);
    if (id_len == 0 || id_len > GEN_TOPIC_DEVICE_ID_MAX) { return false; }
    const size_t need = 6 + id_len + 9 + 1;
    if (cap < need) { return false; }
    memcpy(out, "kiosk/", 6);
    memcpy(out + 6, device_id, id_len);
    memcpy(out + 6 + id_len, "/up/event", 9 + 1);
    return true;
}

static inline bool gen_topic_status(const char *device_id, char *out, size_t cap)
{
    if (device_id == NULL || out == NULL) { return false; }
    const size_t id_len = strlen(device_id);
    if (id_len == 0 || id_len > GEN_TOPIC_DEVICE_ID_MAX) { return false; }
    const size_t need = 6 + id_len + 10 + 1;
    if (cap < need) { return false; }
    memcpy(out, "kiosk/", 6);
    memcpy(out + 6, device_id, id_len);
    memcpy(out + 6 + id_len, "/up/status", 10 + 1);
    return true;
}

static inline bool gen_topic_cmd(const char *device_id, char *out, size_t cap)
{
    if (device_id == NULL || out == NULL) { return false; }
    const size_t id_len = strlen(device_id);
    if (id_len == 0 || id_len > GEN_TOPIC_DEVICE_ID_MAX) { return false; }
    const size_t need = 6 + id_len + 9 + 1;
    if (cap < need) { return false; }
    memcpy(out, "kiosk/", 6);
    memcpy(out + 6, device_id, id_len);
    memcpy(out + 6 + id_len, "/down/cmd", 9 + 1);
    return true;
}

static inline bool gen_topic_enroll(const char *device_id, char *out, size_t cap)
{
    if (device_id == NULL || out == NULL) { return false; }
    const size_t id_len = strlen(device_id);
    if (id_len == 0 || id_len > GEN_TOPIC_DEVICE_ID_MAX) { return false; }
    const size_t need = 6 + id_len + 12 + 1;
    if (cap < need) { return false; }
    memcpy(out, "kiosk/", 6);
    memcpy(out + 6, device_id, id_len);
    memcpy(out + 6 + id_len, "/down/enroll", 12 + 1);
    return true;
}

static inline bool gen_topic_ota(const char *device_id, char *out, size_t cap)
{
    if (device_id == NULL || out == NULL) { return false; }
    const size_t id_len = strlen(device_id);
    if (id_len == 0 || id_len > GEN_TOPIC_DEVICE_ID_MAX) { return false; }
    const size_t need = 6 + id_len + 9 + 1;
    if (cap < need) { return false; }
    memcpy(out, "kiosk/", 6);
    memcpy(out + 6, device_id, id_len);
    memcpy(out + 6 + id_len, "/down/ota", 9 + 1);
    return true;
}

static inline gen_topic_id_t gen_topic_classify(const char *topic, const char *device_id)
{
    if (topic == NULL || device_id == NULL) { return GEN_TOPIC_NONE; }
    char built[GEN_TOPIC_MAX_LEN];
    if (gen_topic_attendance(device_id, built, sizeof(built)) && strcmp(topic, built) == 0) { return GEN_TOPIC_ATTENDANCE; }
    if (gen_topic_heartbeat(device_id, built, sizeof(built)) && strcmp(topic, built) == 0) { return GEN_TOPIC_HEARTBEAT; }
    if (gen_topic_event(device_id, built, sizeof(built)) && strcmp(topic, built) == 0) { return GEN_TOPIC_EVENT; }
    if (gen_topic_status(device_id, built, sizeof(built)) && strcmp(topic, built) == 0) { return GEN_TOPIC_STATUS; }
    if (gen_topic_cmd(device_id, built, sizeof(built)) && strcmp(topic, built) == 0) { return GEN_TOPIC_CMD; }
    if (gen_topic_enroll(device_id, built, sizeof(built)) && strcmp(topic, built) == 0) { return GEN_TOPIC_ENROLL; }
    if (gen_topic_ota(device_id, built, sizeof(built)) && strcmp(topic, built) == 0) { return GEN_TOPIC_OTA; }
    return GEN_TOPIC_NONE;
}

#define GEN_TOPIC_DOWN_COUNT 3

static inline gen_topic_id_t gen_topic_down_at(size_t index)
{
    switch (index) {
    case 0: return GEN_TOPIC_CMD;
    case 1: return GEN_TOPIC_ENROLL;
    case 2: return GEN_TOPIC_OTA;
    default: return GEN_TOPIC_NONE;
    }
}

static inline bool gen_topic_build(gen_topic_id_t id, const char *device_id, char *out, size_t cap)
{
    switch (id) {
    case GEN_TOPIC_ATTENDANCE: return gen_topic_attendance(device_id, out, cap);
    case GEN_TOPIC_HEARTBEAT: return gen_topic_heartbeat(device_id, out, cap);
    case GEN_TOPIC_EVENT: return gen_topic_event(device_id, out, cap);
    case GEN_TOPIC_STATUS: return gen_topic_status(device_id, out, cap);
    case GEN_TOPIC_CMD: return gen_topic_cmd(device_id, out, cap);
    case GEN_TOPIC_ENROLL: return gen_topic_enroll(device_id, out, cap);
    case GEN_TOPIC_OTA: return gen_topic_ota(device_id, out, cap);
    default: return false;
    }
}

static inline uint8_t gen_topic_qos(gen_topic_id_t id)
{
    switch (id) {
    case GEN_TOPIC_ATTENDANCE: return GEN_TOPIC_ATTENDANCE_QOS;
    case GEN_TOPIC_HEARTBEAT: return GEN_TOPIC_HEARTBEAT_QOS;
    case GEN_TOPIC_EVENT: return GEN_TOPIC_EVENT_QOS;
    case GEN_TOPIC_STATUS: return GEN_TOPIC_STATUS_QOS;
    case GEN_TOPIC_CMD: return GEN_TOPIC_CMD_QOS;
    case GEN_TOPIC_ENROLL: return GEN_TOPIC_ENROLL_QOS;
    case GEN_TOPIC_OTA: return GEN_TOPIC_OTA_QOS;
    default: return 0;
    }
}

static inline bool gen_topic_retain(gen_topic_id_t id)
{
    switch (id) {
    case GEN_TOPIC_ATTENDANCE: return GEN_TOPIC_ATTENDANCE_RETAIN;
    case GEN_TOPIC_HEARTBEAT: return GEN_TOPIC_HEARTBEAT_RETAIN;
    case GEN_TOPIC_EVENT: return GEN_TOPIC_EVENT_RETAIN;
    case GEN_TOPIC_STATUS: return GEN_TOPIC_STATUS_RETAIN;
    case GEN_TOPIC_CMD: return GEN_TOPIC_CMD_RETAIN;
    case GEN_TOPIC_ENROLL: return GEN_TOPIC_ENROLL_RETAIN;
    case GEN_TOPIC_OTA: return GEN_TOPIC_OTA_RETAIN;
    default: return false;
    }
}

#ifdef __cplusplus
}
#endif
