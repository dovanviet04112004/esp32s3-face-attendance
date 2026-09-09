#include "vl53l1_platform.h"

#include "app_config.h"
#include "bsp_board.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "tof_platform";

#define PLATFORM_TIMEOUT_MS 100
#define PLATFORM_LOCK_MS 200
#define REGISTER_BYTES 2
#define CHUNK_BYTES 32

static i2c_master_dev_handle_t s_dev;

// The ULD passes dev by value and the board carries one sensor (KEHOACH 2.3),
// so the handle lives here and dev goes unread.
esp_err_t tof_platform_open(void)
{
    if (s_dev != NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    const i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = APP_TOF_I2C_ADDR,
        .scl_speed_hz = APP_I2C_HZ,
    };
    return i2c_master_bus_add_device(bsp_i2c_bus(), &cfg, &s_dev);
}

static int8_t transmit(uint16_t index, const uint8_t *payload, uint32_t count)
{
    uint8_t frame[REGISTER_BYTES + CHUNK_BYTES];
    if (s_dev == NULL || count > CHUNK_BYTES) {
        return -1;
    }
    frame[0] = (uint8_t)(index >> 8);
    frame[1] = (uint8_t)index;
    for (uint32_t i = 0; i < count; ++i) {
        frame[REGISTER_BYTES + i] = payload[i];
    }
    if (bsp_i2c_lock(PLATFORM_LOCK_MS) != ESP_OK) {
        return -1;
    }
    const esp_err_t err =
        i2c_master_transmit(s_dev, frame, REGISTER_BYTES + count, PLATFORM_TIMEOUT_MS);
    bsp_i2c_unlock();
    return err == ESP_OK ? 0 : -1;
}

static int8_t receive(uint16_t index, uint8_t *out, uint32_t count)
{
    const uint8_t reg[REGISTER_BYTES] = {(uint8_t)(index >> 8), (uint8_t)index};
    if (s_dev == NULL) {
        return -1;
    }
    if (bsp_i2c_lock(PLATFORM_LOCK_MS) != ESP_OK) {
        return -1;
    }
    const esp_err_t err = i2c_master_transmit_receive(s_dev, reg, REGISTER_BYTES, out, count,
                                                     PLATFORM_TIMEOUT_MS);
    bsp_i2c_unlock();
    return err == ESP_OK ? 0 : -1;
}

int8_t VL53L1_WriteMulti(uint16_t dev, uint16_t index, uint8_t *pdata, uint32_t count)
{
    (void)dev;
    return transmit(index, pdata, count);
}

int8_t VL53L1_ReadMulti(uint16_t dev, uint16_t index, uint8_t *pdata, uint32_t count)
{
    (void)dev;
    return receive(index, pdata, count);
}

int8_t VL53L1_WrByte(uint16_t dev, uint16_t index, uint8_t data)
{
    (void)dev;
    return transmit(index, &data, 1);
}

int8_t VL53L1_WrWord(uint16_t dev, uint16_t index, uint16_t data)
{
    const uint8_t payload[2] = {(uint8_t)(data >> 8), (uint8_t)data};
    (void)dev;
    return transmit(index, payload, sizeof(payload));
}

int8_t VL53L1_WrDWord(uint16_t dev, uint16_t index, uint32_t data)
{
    const uint8_t payload[4] = {(uint8_t)(data >> 24), (uint8_t)(data >> 16),
                                (uint8_t)(data >> 8), (uint8_t)data};
    (void)dev;
    return transmit(index, payload, sizeof(payload));
}

int8_t VL53L1_RdByte(uint16_t dev, uint16_t index, uint8_t *pdata)
{
    (void)dev;
    return receive(index, pdata, 1);
}

int8_t VL53L1_RdWord(uint16_t dev, uint16_t index, uint16_t *pdata)
{
    uint8_t raw[2] = {0};
    (void)dev;
    const int8_t status = receive(index, raw, sizeof(raw));
    *pdata = (uint16_t)((uint16_t)raw[0] << 8 | raw[1]);
    return status;
}

int8_t VL53L1_RdDWord(uint16_t dev, uint16_t index, uint32_t *pdata)
{
    uint8_t raw[4] = {0};
    (void)dev;
    const int8_t status = receive(index, raw, sizeof(raw));
    *pdata = (uint32_t)raw[0] << 24 | (uint32_t)raw[1] << 16 | (uint32_t)raw[2] << 8 | raw[3];
    return status;
}

int8_t VL53L1_WaitMs(uint16_t dev, int32_t wait_ms)
{
    (void)dev;
    if (wait_ms <= 0) {
        return 0;
    }
    vTaskDelay(pdMS_TO_TICKS(wait_ms) + 1);
    return 0;
}
