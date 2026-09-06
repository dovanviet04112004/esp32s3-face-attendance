/** Buses the board owns, brought up once and shared by every driver above.
 *  @ctx task | blocking | creates m_i2c
 */
#pragma once

#include "driver/i2c_master.h"
#include "driver/spi_master.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Bring up the shared SPI and I2C buses.
 *  @ctx task | blocking | call once from app_main
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE if already up
 */
esp_err_t bsp_board_init(void);

/** Bus handle for the panel, valid after bsp_board_init.
 *  @ctx any | non-blocking
 */
spi_host_device_t bsp_lcd_spi_host(void);

/** Bus handle for GT911, VL53L1X, PCF8574 and the RTC.
 *  @ctx any | non-blocking
 */
i2c_master_bus_handle_t bsp_i2c_bus(void);

/** Take the bus mutex four devices on I2C_NUM_0 contend for.
 *  @ctx task | blocking | takes m_i2c (KEHOACH 5.3)
 *  @ret ESP_OK | ESP_ERR_TIMEOUT
 */
esp_err_t bsp_i2c_lock(uint32_t timeout_ms);

/** Release the bus mutex.
 *  @ctx task | non-blocking | releases m_i2c
 */
void bsp_i2c_unlock(void);

#ifdef __cplusplus
}
#endif
