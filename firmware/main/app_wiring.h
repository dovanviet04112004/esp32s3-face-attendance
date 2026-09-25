/** The queues and flags of KEHOACH 5.3, created in one place.
 *  @ctx task | non-blocking | the layer that ties components together
 */
#pragma once

#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "gen_payload.h"
#include "storage_format.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Every handle a task needs, filled once and never replaced.
 */
/** Who put a roster op on the queue, which decides what applying it means (KEHOACH 7.5). */
typedef enum {
    APP_ROSTER_SERVER = 0,                // a down/enroll push, applied as it says
    APP_ROSTER_ASKED,                     // an operator's RETAKE or DELETE_EMPLOYEE here
    APP_ROSTER_CAPTURED,                  // a capture finished here, off the pending list
    APP_ROSTER_PURGE,                     // a dead ticket: REPLACE_ALL sparing nothing
} app_roster_source_t;

/** Why a pushed UPSERT cannot be stored, decided while decoding it. */
typedef enum {
    APP_ROSTER_USABLE = 0,
    APP_ROSTER_OTHER_MODEL,               // embedded by another recognition model
    APP_ROSTER_BAD_EMBEDDING,             // base64 that is not STORAGE_EMBED_DIM bytes
} app_roster_refusal_t;

// One roster op already decoded on the esp-mqtt task: base64 is cheap there,
// and writing the face table is not (KEHOACH 7.5).
typedef struct {
    int op;                               // enroll_payload_op_t
    uint32_t employee_id;
    uint16_t template_idx;
    uint8_t quality;
    float scale;
    int64_t updated_at;
    uint32_t roster_version;
    bool has_roster_version;
    uint8_t source;                       // app_roster_source_t
    uint8_t refusal;                      // app_roster_refusal_t
    char name[STORAGE_NAME_CAP];
    int8_t embedding[STORAGE_EMBED_DIM];
} app_roster_t;

typedef struct {
    QueueHandle_t frames;                 // q_frame_ai, depth 1, newest wins
    QueueHandle_t results;                // q_result
    QueueHandle_t presence;               // q_presence
    QueueHandle_t sounds;                 // q_audio
    QueueHandle_t uplink;                 // q_uplink
    QueueHandle_t commands;               // q_cmd
    QueueHandle_t events;                 // q_event
    QueueHandle_t roster;                 // q_roster, deep enough for a resync
    QueueHandle_t ota;                    // q_ota, depth 1
    EventGroupHandle_t flags;             // eg_system
} app_wiring_t;

/** Create every queue and the event group.
 *  @ctx task | blocking | call once from app_main, ahead of app_tasks_start
 *  @ret ESP_OK | ESP_ERR_NO_MEM | ESP_ERR_INVALID_STATE if already up
 */
esp_err_t app_wiring_init(void);

/** The one set of handles, valid for the life of the device.
 *  @ctx any | non-blocking
 *  @ret NULL until app_wiring_init has returned ESP_OK
 */
const app_wiring_t *app_wiring(void);

#ifdef __cplusplus
}
#endif
