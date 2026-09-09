/** The seam the ULD calls through, opened once at init.
 *  @ctx task | blocking | takes m_i2c on every ULD call
 */
#pragma once

#include "esp_err.h"

/** Put the sensor on the shared bus so the nine ULD platform calls can reach it.
 *  @ctx task | non-blocking | ESP_ERR_INVALID_STATE on a second call
 */
esp_err_t tof_platform_open(void);
