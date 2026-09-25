/** The offline queue: attendance records on flash, pushed to the broker.
 *  @ctx sync_task | the cursor only moves once the broker acknowledges
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint32_t acked;                       // records the broker took
    uint32_t stalled;                     // drains that stopped on a send
    uint32_t orphans;                     // acked but the cursor write failed
    bool backlog;                         // the log holds more past the cursor
} svc_sync_stats_t;

/** Read the device id and open the log, without sending anything.
 *  @ctx task | blocking | takes m_littlefs
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE on a second call
 */
esp_err_t svc_sync_init(void);

/** Send what the cursor has not reached yet, up to one batch, placing unclocked stamps.
 *  @ctx task | blocking up to batch x ack timeout | takes m_littlefs
 *  @param wait_for_clock stop at this boot's unclocked stamp until a clock can place it
 *  @ret ESP_OK drained or nothing to do | ESP_ERR_INVALID_STATE broker down or waiting
 *       | ESP_ERR_TIMEOUT unacknowledged | ESP_ERR_NOT_FINISHED batch full
 */
esp_err_t svc_sync_drain(bool wait_for_clock);

/** Whether the log still holds a record the broker has not taken.
 *  @ctx any | non-blocking | the answer is from the last drain
 */
bool svc_sync_pending(void);

/** Counters since init, for the settings screen and the soak test.
 *  @ctx any | non-blocking
 */
svc_sync_stats_t svc_sync_stats(void);

#ifdef __cplusplus
}
#endif
