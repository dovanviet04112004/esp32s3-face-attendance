/** The eight PCF8574 lines, addressed one at a time.
 *  @ctx task | blocking | every call takes m_i2c
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Latch the power-up state into the shadow and confirm the chip answers.
 *  @ctx task | blocking | call after bsp_board_init
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND when nothing answers at the address
 */
esp_err_t drv_ioexp_init(void);

/** Drive one line, leaving the other seven where the shadow says they are.
 *  @ctx task | blocking | takes m_i2c
 *  @param pin 0 to 7, named by the APP_IOEXP_P_* constants
 */
esp_err_t drv_ioexp_set(uint8_t pin, bool high);

/** Read the whole port, which is what the chip returns for any single line.
 *  @ctx task | blocking | takes m_i2c
 *  @param out receives the eight lines, bit 0 for P0
 */
esp_err_t drv_ioexp_read(uint8_t *out);

#ifdef __cplusplus
}
#endif
