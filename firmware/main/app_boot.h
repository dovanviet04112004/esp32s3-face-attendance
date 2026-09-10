/** The init sequence of the kiosk, from storage up to the network.
 *  @ctx task | blocking | shared with test_apps/soak (KEHOACH 4.5.2)
 */
#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Bring up every driver and service, then seed the flags of eg_system.
 *  @ctx task | blocking ~2 s | call once, ahead of app_tasks_start
 *  @ret ESP_OK, or aborts on a fault that leaves no kiosk to run
 */
esp_err_t app_boot(void);

#ifdef __cplusplus
}
#endif
