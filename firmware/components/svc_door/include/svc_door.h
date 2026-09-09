/** The barrier as the attendance logic sees it: raised for a while, then lowered.
 *  @ctx task | non-blocking | open and close take m_door (KEHOACH 5.3)
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct svc_door_s *svc_door_t;

/** What a fake door has been told so far. */
typedef struct {
    uint32_t open_calls;
    uint32_t close_calls;
    uint32_t last_hold_ms;
} svc_door_fake_log_t;

/** The real barrier on the SG90, built once and lowered on first use.
 *  @ctx task | non-blocking | call after drv_servo_init
 *  @ret NULL when its mutex or timer could not be created
 */
svc_door_t svc_door_servo(void);

/** A door that only records what it is told, for tests without a board.
 *  @ctx any | non-blocking
 */
svc_door_t svc_door_fake(void);

/** Raise the barrier and lower it hold_ms later; a call while raised extends the hold.
 *  @ctx task | non-blocking | takes m_door
 *  @ret ESP_OK | ESP_ERR_INVALID_ARG on a null door | ESP_ERR_TIMEOUT
 */
esp_err_t svc_door_open(svc_door_t door, uint32_t hold_ms);

/** Lower the barrier now and drop any pending hold.
 *  @ctx task | non-blocking | takes m_door
 *  @ret ESP_OK | ESP_ERR_INVALID_ARG on a null door | ESP_ERR_TIMEOUT
 */
esp_err_t svc_door_close(svc_door_t door);

/** Whether the barrier is raised, false while it is lowering or limp.
 *  @ctx any | non-blocking
 */
bool svc_door_is_open(svc_door_t door);

/** Read back what a fake door received; zeros for the real door.
 *  @ctx any | non-blocking
 */
void svc_door_fake_log(svc_door_t door, svc_door_fake_log_t *out);

#ifdef __cplusplus
}
#endif
