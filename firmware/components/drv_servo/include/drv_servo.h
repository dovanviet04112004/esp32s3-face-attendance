/** The SG90 that swings the barrier: one 50 Hz pulse train on its signal pin.
 *  @ctx task | non-blocking
 */
#pragma once

#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Claim an LEDC timer and channel for the pulse; the arm gets no pulse yet.
 *  @ctx task | non-blocking
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE on a second call
 */
esp_err_t drv_servo_init(void);

/** Hold the arm at an angle across the APP_SERVO_MIN_US..APP_SERVO_MAX_US pulse range.
 *  @ctx task | non-blocking | the arm itself needs 0.1 s per 60 degrees (SG90 DS)
 *  @param angle_deg 0 to 180, larger values are clamped
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE without init
 */
esp_err_t drv_servo_angle(uint8_t angle_deg);

/** Stop the pulse so the arm goes limp and the motor stops drawing current.
 *  @ctx task | non-blocking
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE without init
 */
esp_err_t drv_servo_release(void);

/** The pulse width the pin is being driven with, 0 while released.
 *  @ctx any | non-blocking
 */
uint32_t drv_servo_pulse_us(void);

#ifdef __cplusplus
}
#endif
