/** The tasks that run for the life of the device, created in one place.
 *  @ctx task | blocking | core and priority come from KEHOACH 5.2
 */
#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Create every long-running task.
 *  @ctx task | blocking | call once from app_main, after the drivers are up
 *  @ret ESP_OK | ESP_ERR_NO_MEM when a task will not start
 */
esp_err_t app_tasks_start(void);

#ifdef __cplusplus
}
#endif
