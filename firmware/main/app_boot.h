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

/** Why the models pack would not load this boot, so the uplink can say so.
 *  @ctx any | non-blocking | set by app_boot
 *  @ret ESP_OK once every branch is built, else the error of ai_engine_init
 */
esp_err_t app_boot_models_error(void);

#ifdef __cplusplus
}
#endif
