#include "app_config.h"
#include "bsp_board.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "drv_lcd.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "app_main";

#define I2C_PROBE_FIRST 0x08
#define I2C_PROBE_LAST 0x77
#define I2C_PROBE_TIMEOUT_MS 20
#define I2C_PLAUSIBLE_MAX 8
#define LINE_SETTLE_US 200

#define RGB565(r, g, b) (uint16_t)(((r) & 0xF8) << 8 | ((g) & 0xFC) << 3 | (b) >> 3)
#define BRINGUP_HOLD_MS 700

static const uint16_t BRINGUP_COLOURS[] = {
    RGB565(0xFF, 0x00, 0x00),
    RGB565(0x00, 0xFF, 0x00),
    RGB565(0x00, 0x00, 0xFF),
    RGB565(0xFF, 0xFF, 0xFF),
};

static void probe_pin(const char *name, int gpio)
{
    gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << gpio,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&cfg));
    esp_rom_delay_us(LINE_SETTLE_US);
    const int on_pullup = gpio_get_level(gpio);

    cfg.pull_up_en = GPIO_PULLUP_DISABLE;
    cfg.pull_down_en = GPIO_PULLDOWN_ENABLE;
    ESP_ERROR_CHECK(gpio_config(&cfg));
    esp_rom_delay_us(LINE_SETTLE_US);
    const int on_pulldown = gpio_get_level(gpio);

    const char *verdict = "?";
    if (!on_pullup) {
        verdict = "TIED LOW - shorted to GND";
    } else if (on_pulldown) {
        verdict = "external pull-up present, line healthy";
    } else {
        verdict = "floating - no external pull-up reaches this pin";
    }
    ESP_LOGI(TAG, "%s gpio%d: pullup=%d pulldown=%d -> %s", name, gpio, on_pullup,
             on_pulldown, verdict);
}

static void test_i2c_lines(void)
{
    probe_pin("SDA", APP_I2C_SDA_GPIO);
    probe_pin("SCL", APP_I2C_SCL_GPIO);

    const gpio_config_t cfg = {
        .pin_bit_mask = (1ULL << APP_I2C_SDA_GPIO) | (1ULL << APP_I2C_SCL_GPIO),
        .mode = GPIO_MODE_INPUT_OUTPUT_OD,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&cfg));
    gpio_set_level(APP_I2C_SDA_GPIO, 1);
    gpio_set_level(APP_I2C_SCL_GPIO, 1);
    esp_rom_delay_us(LINE_SETTLE_US);
    const int idle_sda = gpio_get_level(APP_I2C_SDA_GPIO);
    const int idle_scl = gpio_get_level(APP_I2C_SCL_GPIO);

    gpio_set_level(APP_I2C_SDA_GPIO, 0);
    esp_rom_delay_us(LINE_SETTLE_US);
    const int scl_follows = gpio_get_level(APP_I2C_SCL_GPIO);
    gpio_set_level(APP_I2C_SDA_GPIO, 1);
    esp_rom_delay_us(LINE_SETTLE_US);

    gpio_set_level(APP_I2C_SCL_GPIO, 0);
    esp_rom_delay_us(LINE_SETTLE_US);
    const int sda_follows = gpio_get_level(APP_I2C_SDA_GPIO);
    gpio_set_level(APP_I2C_SCL_GPIO, 1);

    ESP_LOGI(TAG, "lines: idle sda=%d scl=%d", idle_sda, idle_scl);
    ESP_LOGI(TAG, "lines: sda pulled low -> scl reads %d (1 = separate)", scl_follows);
    ESP_LOGI(TAG, "lines: scl pulled low -> sda reads %d (1 = separate)", sda_follows);
}

static bool bus_idles_high(void)
{
    const int sda = gpio_get_level(APP_I2C_SDA_GPIO);
    const int scl = gpio_get_level(APP_I2C_SCL_GPIO);
    ESP_LOGI(TAG, "i2c idle level sda=%d scl=%d", sda, scl);
    if (sda && scl) {
        return true;
    }
    // A line held down reads as ACK at every address, so a scan over a stuck
    // bus reports all 112 of them rather than nothing (KEHOACH 2.3).
    ESP_LOGE(TAG, "i2c idle level sda=%d scl=%d, expected 1 and 1", sda, scl);
    ESP_LOGE(TAG, "bus held low: short to GND, swapped pins, or no pull-up");
    return false;
}

static void scan_i2c(void)
{
    if (!bus_idles_high()) {
        return;
    }
    i2c_master_bus_handle_t bus = bsp_i2c_bus();
    int found = 0;
    // A silent address is how a scan reports absence, so the driver's own
    // timeout error is noise here and would bury the addresses that answered.
    esp_log_level_set("i2c.master", ESP_LOG_NONE);
    uint16_t first = 0;
    for (uint16_t addr = I2C_PROBE_FIRST; addr <= I2C_PROBE_LAST; ++addr) {
        if (i2c_master_probe(bus, addr, I2C_PROBE_TIMEOUT_MS) == ESP_OK) {
            if (found < I2C_PLAUSIBLE_MAX) {
                ESP_LOGI(TAG, "i2c 0x%02X answered", addr);
            }
            if (!found) {
                first = addr;
            }
            found++;
        }
    }
    esp_log_level_set("i2c.master", ESP_LOG_INFO);
    // More answers than the bus can hold means SDA reads low during every ACK
    // window, which is a wiring fault reported as a device list (KEHOACH 2.3).
    if (found > I2C_PLAUSIBLE_MAX) {
        ESP_LOGE(TAG, "%d of %d addresses answered: bus faulty, not populated",
                 found, I2C_PROBE_LAST - I2C_PROBE_FIRST + 1);
        return;
    }
    ESP_LOGI(TAG, "i2c scan done, %d device(s), first 0x%02X", found, found ? first : 0);
}

void app_main(void)
{
    test_i2c_lines();
    ESP_ERROR_CHECK(bsp_board_init());
    ESP_ERROR_CHECK(drv_lcd_init());
    ESP_ERROR_CHECK(drv_lcd_backlight(100));

    for (size_t i = 0; i < sizeof(BRINGUP_COLOURS) / sizeof(BRINGUP_COLOURS[0]); ++i) {
        ESP_ERROR_CHECK(drv_lcd_fill(BRINGUP_COLOURS[i]));
        vTaskDelay(pdMS_TO_TICKS(BRINGUP_HOLD_MS));
    }
    ESP_LOGI(TAG, "panel reached every colour");
    scan_i2c();
}
