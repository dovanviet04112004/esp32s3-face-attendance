#include "bsp_board.h"

#include "app_config.h"
#include "app_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "bsp_board";

#define LCD_SPI_HOST SPI2_HOST
#define I2C_READY_CEILING_MS 500
#define I2C_READY_STEP_MS 5
#define I2C_ACK_WAIT_MS 20

static i2c_master_bus_handle_t s_i2c_bus;
static SemaphoreHandle_t s_i2c_mutex;
static bool s_ready;

static esp_err_t spi_bus_up(void)
{
    const spi_bus_config_t cfg = {
        .sclk_io_num = APP_LCD_SCK_GPIO,
        .mosi_io_num = APP_LCD_MOSI_GPIO,
        .miso_io_num = APP_LCD_SDO_GPIO,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = APP_LCD_H_RES * APP_LCD_V_RES * sizeof(uint16_t),
    };
    return spi_bus_initialize(LCD_SPI_HOST, &cfg, SPI_DMA_CH_AUTO);
}

static esp_err_t i2c_bus_up(void)
{
    const i2c_master_bus_config_t cfg = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = APP_I2C_SDA_GPIO,
        .scl_io_num = APP_I2C_SCL_GPIO,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        // The bus carries one 4.7k pair, and the ~45k inside the chip would sit
        // across it and weaken the edge the fast devices need (KEHOACH 2.3).
        .flags.enable_internal_pullup = false,
    };
    return i2c_new_master_bus(&cfg, &s_i2c_bus);
}

static esp_err_t wait_for_bus_devices(void)
{
    // i2c_new_master_bus succeeding says nothing about the devices: at 4 ms
    // after boot none of them answers yet, measured (KEHOACH 2.3).
    const uint16_t addrs[] = {APP_IOEXP_I2C_ADDR, APP_TOF_I2C_ADDR};
    const size_t count = sizeof(addrs) / sizeof(addrs[0]);
    bool answered[sizeof(addrs) / sizeof(addrs[0])] = {false};
    esp_log_level_set("i2c.master", ESP_LOG_NONE);
    for (int waited_ms = 0; waited_ms <= I2C_READY_CEILING_MS; waited_ms += I2C_READY_STEP_MS) {
        size_t seen = 0;
        for (size_t i = 0; i < count; ++i) {
            answered[i] = answered[i] ||
                          i2c_master_probe(s_i2c_bus, addrs[i], I2C_ACK_WAIT_MS) == ESP_OK;
            seen += answered[i] ? 1 : 0;
        }
        if (seen == count) {
            esp_log_level_set("i2c.master", ESP_LOG_INFO);
            ESP_LOGI(TAG, "i2c ready after %d ms", waited_ms);
            return ESP_OK;
        }
        vTaskDelay(pdMS_TO_TICKS(I2C_READY_STEP_MS));
    }
    esp_log_level_set("i2c.master", ESP_LOG_INFO);
    for (size_t i = 0; i < count; ++i) {
        if (!answered[i]) {
            ESP_LOGE(TAG, "i2c 0x%02X silent after %d ms", addrs[i], I2C_READY_CEILING_MS);
        }
    }
    return ESP_ERR_NOT_FOUND;
}

esp_err_t bsp_board_init(void)
{
    if (s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    s_i2c_mutex = xSemaphoreCreateMutex();
    if (s_i2c_mutex == NULL) {
        return ESP_ERR_NO_MEM;
    }
    APP_RETURN_ON_ERR(spi_bus_up(), TAG, "spi bus");
    APP_RETURN_ON_ERR(i2c_bus_up(), TAG, "i2c bus");
    APP_RETURN_ON_ERR(wait_for_bus_devices(), TAG, "i2c devices");
    s_ready = true;
    ESP_LOGI(TAG, "spi2 and i2c0 up");
    return ESP_OK;
}

spi_host_device_t bsp_lcd_spi_host(void)
{
    return LCD_SPI_HOST;
}

i2c_master_bus_handle_t bsp_i2c_bus(void)
{
    return s_i2c_bus;
}

esp_err_t bsp_i2c_lock(uint32_t timeout_ms)
{
    return xSemaphoreTake(s_i2c_mutex, pdMS_TO_TICKS(timeout_ms)) == pdTRUE ? ESP_OK
                                                                            : ESP_ERR_TIMEOUT;
}

void bsp_i2c_unlock(void)
{
    xSemaphoreGive(s_i2c_mutex);
}
