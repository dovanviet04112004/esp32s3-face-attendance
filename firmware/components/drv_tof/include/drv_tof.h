/** The VL53L1X rangefinder: distance in millimetres, and its ready line.
 *  @ctx task | blocking | reads take m_i2c
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Release XSHUT, boot the sensor and start ranging in short mode.
 *  @ctx task | blocking, holds about 60 ms | call after drv_ioexp_init
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND when the sensor stays silent
 *       | ESP_ERR_INVALID_STATE on a second call
 */
esp_err_t drv_tof_init(void);

/** The distance of the last completed measurement.
 *  @ctx task | blocking | takes m_i2c
 *  @param status_ok receives false when the sensor flags the reading unreliable
 *  @ret ESP_OK | ESP_ERR_TIMEOUT when no measurement has completed yet
 */
esp_err_t drv_tof_read_mm(uint16_t *distance_mm, bool *status_ok);

/** The semaphore the GPIO3 handler gives once per completed measurement.
 *  @ctx any | non-blocking | valid after drv_tof_init, never taken from an ISR
 */
SemaphoreHandle_t drv_tof_ready_signal(void);

#ifdef __cplusplus
}
#endif
