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

/** The backlight percent NVS holds, kept to the floor a dark panel cannot be read below.
 *  @ctx task | blocking | reads NVS
 */
uint8_t app_boot_brightness(void);

/** Why the models pack would not load this boot, so the uplink can say so.
 *  @ctx any | non-blocking | set by app_boot
 *  @ret ESP_OK once every branch is built, else the error of ai_engine_init
 */
esp_err_t app_boot_models_error(void);

/** Why the chip last started, in a few words for the boot log and the BOOTED note (KEHOACH 4.8).
 *  @ctx any | non-blocking
 */
const char *app_boot_reset_cause(void);

#ifdef __cplusplus
}
#endif
