#include "app_config.h"
#include "bsp_board.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "unity.h"

#define LOCK_WAIT_MS 50
#define PROBE_WAIT_MS 20
#define PROBE_JOIN_MS 500
#define PROBE_STACK_BYTES 2048
#define PROBE_PRIORITY 6
#define ACK_WAIT_MS 20
#define PIN_SETTLE_US 200
#define SCAN_FIRST_ADDR 0x08
#define SCAN_LAST_ADDR 0x77
#define DEVICES_MIN 1
#define DEVICES_MAX 8

static const char *TAG = "test_buses";

static SemaphoreHandle_t s_probe_done;
static esp_err_t s_probe_result;

static bool holds_its_level_against_the_chip(int gpio)
{
    gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << gpio,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_ENABLE,
    };
    TEST_ASSERT_EQUAL(ESP_OK, gpio_config(&cfg));
    esp_rom_delay_us(PIN_SETTLE_US);
    const int level = gpio_get_level(gpio);

    cfg.pull_up_en = GPIO_PULLUP_DISABLE;
    cfg.pull_down_en = GPIO_PULLDOWN_DISABLE;
    TEST_ASSERT_EQUAL(ESP_OK, gpio_config(&cfg));
    return level == 1;
}

static void take_the_bus(void *arg)
{
    (void)arg;
    s_probe_result = bsp_i2c_lock(PROBE_WAIT_MS);
    if (s_probe_result == ESP_OK) {
        bsp_i2c_unlock();
    }
    xSemaphoreGive(s_probe_done);
    vTaskDelete(NULL);
}

static void start_probe(void)
{
    s_probe_done = xSemaphoreCreateBinary();
    TEST_ASSERT_NOT_NULL(s_probe_done);
    // Above the caller, so the probe reaches the lock while the caller still holds it.
    TEST_ASSERT_EQUAL(pdPASS, xTaskCreate(take_the_bus, "i2c_probe", PROBE_STACK_BYTES, NULL,
                                          PROBE_PRIORITY, NULL));
}

static void join_probe(void)
{
    TEST_ASSERT_EQUAL(pdTRUE, xSemaphoreTake(s_probe_done, pdMS_TO_TICKS(PROBE_JOIN_MS)));
    vSemaphoreDelete(s_probe_done);
}

TEST_CASE("both i2c lines carry an external pull-up", "[bsp_board]")
{
    // Reads the pins as plain GPIO, which stops being possible once bsp_board_init
    // hands them to the I2C driver, so this case has to run first.
    TEST_ASSERT_TRUE_MESSAGE(holds_its_level_against_the_chip(APP_I2C_SDA_GPIO),
                             "SDA sits low against an internal pull-down: no 4.7k, or an open wire");
    TEST_ASSERT_TRUE_MESSAGE(holds_its_level_against_the_chip(APP_I2C_SCL_GPIO),
                             "SCL sits low against an internal pull-down: no 4.7k, or an open wire");
}

TEST_CASE("init brings both buses up and refuses a second time", "[bsp_board]")
{
    TEST_ASSERT_EQUAL(ESP_OK, bsp_board_init());
    TEST_ASSERT_NOT_NULL(bsp_i2c_bus());
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, bsp_board_init());
}

TEST_CASE("a held bus mutex turns a second task away", "[bsp_board]")
{
    TEST_ASSERT_EQUAL(ESP_OK, bsp_i2c_lock(LOCK_WAIT_MS));
    start_probe();
    join_probe();
    bsp_i2c_unlock();
    TEST_ASSERT_EQUAL(ESP_ERR_TIMEOUT, s_probe_result);
}

TEST_CASE("unlock hands the bus to the task waiting on it", "[bsp_board]")
{
    TEST_ASSERT_EQUAL(ESP_OK, bsp_i2c_lock(LOCK_WAIT_MS));
    start_probe();
    bsp_i2c_unlock();
    join_probe();
    TEST_ASSERT_EQUAL(ESP_OK, s_probe_result);
}

TEST_CASE("init hands back a bus that already carries a transfer", "[bsp_board]")
{
    // Both devices are silent 4 ms after boot, so an init that only creates the
    // bus lets whichever driver runs first NACK (KEHOACH 2.3).
    uint8_t all_high = 0xFF;
    i2c_master_dev_handle_t dev = NULL;
    const i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = APP_IOEXP_I2C_ADDR,
        .scl_speed_hz = APP_I2C_HZ,
    };
    TEST_ASSERT_EQUAL(ESP_OK, i2c_master_bus_add_device(bsp_i2c_bus(), &cfg, &dev));
    TEST_ASSERT_EQUAL(ESP_OK, bsp_i2c_lock(LOCK_WAIT_MS));
    const esp_err_t err = i2c_master_transmit(dev, &all_high, 1, ACK_WAIT_MS);
    bsp_i2c_unlock();
    TEST_ASSERT_EQUAL(ESP_OK, i2c_master_bus_rm_device(dev));
    TEST_ASSERT_EQUAL_MESSAGE(ESP_OK, err, "init returned before the bus could carry a write");
}

TEST_CASE("the expander answers where app_config places it", "[bsp_board]")
{
    TEST_ASSERT_EQUAL(ESP_OK, bsp_i2c_lock(LOCK_WAIT_MS));
    const esp_err_t err = i2c_master_probe(bsp_i2c_bus(), APP_IOEXP_I2C_ADDR, ACK_WAIT_MS);
    bsp_i2c_unlock();
    TEST_ASSERT_EQUAL(ESP_OK, err);
}

TEST_CASE("the bus answers for a populated count, not every address", "[bsp_board]")
{
    int found = 0;
    // A silent address is how a scan reports absence, so the driver's own timeout
    // error is noise here and would bury the addresses that answered.
    esp_log_level_set("i2c.master", ESP_LOG_NONE);
    TEST_ASSERT_EQUAL(ESP_OK, bsp_i2c_lock(LOCK_WAIT_MS));
    for (uint16_t addr = SCAN_FIRST_ADDR; addr <= SCAN_LAST_ADDR; ++addr) {
        if (i2c_master_probe(bsp_i2c_bus(), addr, ACK_WAIT_MS) == ESP_OK) {
            ESP_LOGI(TAG, "i2c 0x%02X answered", addr);
            found++;
        }
    }
    bsp_i2c_unlock();
    esp_log_level_set("i2c.master", ESP_LOG_INFO);
    // Every address answering means SDA reads low during each ACK window, which
    // is a wiring fault that looks like a full bus (KEHOACH 2.3).
    TEST_ASSERT_GREATER_OR_EQUAL(DEVICES_MIN, found);
    TEST_ASSERT_LESS_OR_EQUAL_MESSAGE(DEVICES_MAX, found, "bus faulty, not populated");
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
}
