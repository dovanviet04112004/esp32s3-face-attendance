/** Provisioning console, compiled only when CONFIG_APP_CONSOLE is set.
 *  @ctx task | non-blocking | spawns the repl task
 */
#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Serve nvs get and nvs set on the USB port until reboot.
 *  @ctx task | non-blocking | call after sys_storage_init
 *  @ret ESP_OK | ESP_ERR_NOT_SUPPORTED when the console is compiled out
 */
esp_err_t app_console_start(void);

#ifdef __cplusplus
}
#endif
