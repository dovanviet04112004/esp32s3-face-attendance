/** The attendance state machine: vision events in, door and records out.
 *  @ctx task | blocking | one caller, the attend_task of KEHOACH 5.2
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "storage_format.h"
#include "svc_door.h"
#include "svc_vision.h"

#ifdef __cplusplus
extern "C" {
#endif

/** The six states of KEHOACH 4.5.5f, in the order the table lists them. */
typedef enum {
    SVC_ATTENDANCE_IDLE = 0,
    SVC_ATTENDANCE_DETECTING,
    SVC_ATTENDANCE_VERIFYING,
    SVC_ATTENDANCE_GRANTED,
    SVC_ATTENDANCE_DENIED,
    SVC_ATTENDANCE_COOLDOWN,
} svc_attendance_state_t;

/** The two business calls of KEHOACH 4.5.5f, seeded from the attend namespace. */
typedef struct {
    uint32_t dedup_min;      // a second stamp for one person waits this long
    bool allow_no_spoof;     // open on a negative liveness score, for a bench
} svc_attendance_policy_t;

/** What one vision event came to, for the screen and the speaker (KEHOACH 4.5.5f). */
typedef enum {
    SVC_ATTENDANCE_SAID_NOTHING = 0,      // guidance, or no row in this state
    SVC_ATTENDANCE_SAID_GRANTED,          // the door opened for this face
    SVC_ATTENDANCE_SAID_ALREADY,          // this arrival is stamped already, door stays shut
    SVC_ATTENDANCE_SAID_REFUSED,          // spoof, stranger, or liveness policy refused
} svc_attendance_said_t;

/** Take the door and the policy; nothing is allocated after this call.
 *  @ctx task | non-blocking | pass svc_door_fake() to run without a board
 *  @ret ESP_OK | ESP_ERR_INVALID_ARG on a null door | ESP_ERR_INVALID_STATE
 */
esp_err_t svc_attendance_init(svc_door_t door, const svc_attendance_policy_t *policy);

/** Replace the policy while running, as SET_CONFIG of KEHOACH 6.2.1 does.
 *  @ctx task | non-blocking
 *  @ret ESP_OK | ESP_ERR_INVALID_ARG | ESP_ERR_INVALID_STATE without init
 */
esp_err_t svc_attendance_set_policy(const svc_attendance_policy_t *policy);

/** Feed one vision event, which may open the door and write a record.
 *  @ctx task | blocking on the door and on LittleFS | takes m_door, m_littlefs
 *  @param now_ms the wall clock of KEHOACH 6.2.5, stamped into the record
 *  @param said what the event came to, or NULL when nobody asks
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE without init
 */
esp_err_t svc_attendance_on_vision(const svc_vision_result_t *result, int64_t now_ms,
                                   svc_attendance_said_t *said);

/** Tell the machine whether anyone is standing there.
 *  @ctx task | non-blocking
 */
esp_err_t svc_attendance_on_presence(bool present);

/** Tell the machine whether the broker is reachable right now.
 *  @ctx any | non-blocking | sets flags bit1 on records stamped without it
 */
void svc_attendance_set_link(bool up);

/** Advance the timers that carry Granted, Denied and Cooldown along.
 *  @ctx task | non-blocking | call on a tick of at most a few hundred ms
 */
esp_err_t svc_attendance_tick(int64_t now_ms);

/** Which state the machine sits in right now.
 *  @ctx any | non-blocking
 */
svc_attendance_state_t svc_attendance_state(void);

/** The policy in force, for a caller facing the same decision on another path.
 *  @ctx any | non-blocking
 *  @ret ESP_OK | ESP_ERR_INVALID_ARG | ESP_ERR_INVALID_STATE without init
 */
esp_err_t svc_attendance_policy(svc_attendance_policy_t *out);

/** The last record this machine wrote, for a test or a screen to read back.
 *  @ctx any | non-blocking
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND when nothing has been stamped yet
 */
esp_err_t svc_attendance_last_record(storage_attend_record_t *out);

/** How many records this machine has written since init.
 *  @ctx any | non-blocking
 */
uint32_t svc_attendance_records(void);

#ifdef __cplusplus
}
#endif
