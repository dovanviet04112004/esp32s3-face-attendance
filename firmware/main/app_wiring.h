/** The queues and flags of KEHOACH 5.3, created in one place.
 *  @ctx task | non-blocking | the layer that ties components together
 */
#pragma once

#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Every handle a task needs, filled once and never replaced.
 */
typedef struct {
    QueueHandle_t frames;                 // q_frame_ai, depth 1, newest wins
    QueueHandle_t results;                // q_result
    QueueHandle_t presence;               // q_presence
    QueueHandle_t sounds;                 // q_audio
    QueueHandle_t uplink;                 // q_uplink
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
