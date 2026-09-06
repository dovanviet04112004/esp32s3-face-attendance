#include "bsp_board.h"

#include "app_config.h"
#include "app_err.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "bsp_board";

#define LCD_SPI_HOST SPI2_HOST
#define I2C_LOCK_DEFAULT_MS 1000
#define PIN_SETTLE_US 200
#define I2C_PROBE_FIRST 0x08
#define I2C_PROBE_LAST 0x77
#define I2C_PROBE_TIMEOUT_MS 20
#define I2C_PLAUSIBLE_MAX 8

static i2c_master_bus_handle_t s_i2c_bus;
static SemaphoreHandle_t s_i2c_mutex;
static bool s_ready;

static esp_err_t spi_bus_up(void)
{
    const spi_bus_config_t cfg = {
        .sclk_io_num = APP_LCD_SCK_GPIO,
        .mosi_io_num = APP_LCD_MOSI_GPIO,
        .miso_io_num = -1,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = APP_LCD_H_RES * APP_LCD_V_RES * sizeof(uint16_t),
    };
    return spi_bus_initialize(LCD_SPI_HOST, &cfg, SPI_DMA_CH_AUTO);
}

#if CONFIG_BSP_BRINGUP_CHECKS
static void report_pin(const char *name, int gpio)
{
    gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << gpio,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&cfg));
    esp_rom_delay_us(PIN_SETTLE_US);
    const int on_pullup = gpio_get_level(gpio);

    cfg.pull_up_en = GPIO_PULLUP_DISABLE;
    cfg.pull_down_en = GPIO_PULLDOWN_ENABLE;
    ESP_ERROR_CHECK(gpio_config(&cfg));
    esp_rom_delay_us(PIN_SETTLE_US);
    const int on_pulldown = gpio_get_level(gpio);

    const char *verdict = on_pullup
                              ? (on_pulldown ? "external pull-up wins: reaches a powered device"
                                             : "no external pull-up: missing resistor OR open wire")
                              : "tied low: shorted to GND";
    ESP_LOGI(TAG, "%s gpio%d: %s", name, gpio, verdict);
}
#endif

static esp_err_t i2c_bus_up(void)
{
#if CONFIG_BSP_BRINGUP_CHECKS
    // Reads the two pins as plain GPIO, which stops being possible once the
    // I2C driver claims them below.
    report_pin("SDA", APP_I2C_SDA_GPIO);
    report_pin("SCL", APP_I2C_SCL_GPIO);
#endif

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
    const uint32_t wait = timeout_ms ? timeout_ms : I2C_LOCK_DEFAULT_MS;
    return xSemaphoreTake(s_i2c_mutex, pdMS_TO_TICKS(wait)) == pdTRUE ? ESP_OK : ESP_ERR_TIMEOUT;
}

void bsp_i2c_unlock(void)
{
    xSemaphoreGive(s_i2c_mutex);
}

int bsp_i2c_scan(void)
{
#if !CONFIG_BSP_BRINGUP_CHECKS
    return 0;
#else
    int found = 0;
    // A silent address is how a scan reports absence, so the driver's own
    // timeout error is noise here and would bury the addresses that answered.
    esp_log_level_set("i2c.master", ESP_LOG_NONE);
    for (uint16_t addr = I2C_PROBE_FIRST; addr <= I2C_PROBE_LAST; ++addr) {
        if (i2c_master_probe(s_i2c_bus, addr, I2C_PROBE_TIMEOUT_MS) == ESP_OK) {
            if (found < I2C_PLAUSIBLE_MAX) {
                ESP_LOGI(TAG, "i2c 0x%02X answered", addr);
            }
            found++;
        }
    }
    esp_log_level_set("i2c.master", ESP_LOG_INFO);
    // More answers than the bus can hold means SDA reads low during every ACK
    // window, which is a wiring fault reported as a device list (KEHOACH 2.3).
    if (found > I2C_PLAUSIBLE_MAX) {
        ESP_LOGE(TAG, "%d of %d addresses answered: bus faulty, not populated", found,
                 I2C_PROBE_LAST - I2C_PROBE_FIRST + 1);
        return -1;
    }
    ESP_LOGI(TAG, "i2c scan done, %d device(s)", found);
    return found;
#endif
}
