#include "drv_ioexp.h"

#include "app_config.h"
#include "app_err.h"
#include "bsp_board.h"
#include "esp_log.h"

static const char *TAG = "drv_ioexp";

#define IOEXP_PIN_COUNT 8
#define IOEXP_TIMEOUT_MS 100
#define IOEXP_LOCK_MS 200
// Every line floats high through a ~100 uA source at power-up, so the shadow
// starts where the hardware already is (KEHOACH 2.3).
#define IOEXP_POWER_UP_STATE 0xFF

static i2c_master_dev_handle_t s_dev;
static uint8_t s_shadow = IOEXP_POWER_UP_STATE;

static esp_err_t write_port(uint8_t value)
{
    APP_RETURN_ON_ERR(bsp_i2c_lock(IOEXP_LOCK_MS), TAG, "lock");
    const esp_err_t err = i2c_master_transmit(s_dev, &value, 1, IOEXP_TIMEOUT_MS);
    bsp_i2c_unlock();
    return err;
}

esp_err_t drv_ioexp_init(void)
{
    if (s_dev != NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    const i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = APP_IOEXP_I2C_ADDR,
        .scl_speed_hz = APP_I2C_HZ,
    };
    APP_RETURN_ON_ERR(i2c_master_bus_add_device(bsp_i2c_bus(), &cfg, &s_dev), TAG, "add device");
    APP_RETURN_ON_ERR(write_port(s_shadow), TAG, "first write");
    ESP_LOGI(TAG, "pcf8574 at 0x%02X, shadow 0x%02X", APP_IOEXP_I2C_ADDR, s_shadow);
    return ESP_OK;
}

esp_err_t drv_ioexp_set(uint8_t pin, bool high)
{
    if (pin >= IOEXP_PIN_COUNT) {
        return ESP_ERR_INVALID_ARG;
    }
    // The chip takes all eight lines in one byte, so a single-line change has
    // to carry the other seven with it.
    const uint8_t next = high ? (s_shadow | (uint8_t)(1u << pin))
                              : (uint8_t)(s_shadow & ~(1u << pin));
    APP_RETURN_ON_ERR(write_port(next), TAG, "set");
    s_shadow = next;
    return ESP_OK;
}

esp_err_t drv_ioexp_read(uint8_t *out)
{
    if (out == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    APP_RETURN_ON_ERR(bsp_i2c_lock(IOEXP_LOCK_MS), TAG, "lock");
    const esp_err_t err = i2c_master_receive(s_dev, out, 1, IOEXP_TIMEOUT_MS);
    bsp_i2c_unlock();
    return err;
}
