#include <stdio.h>

#include "app_config.h"
#include "bsp_board.h"
#include "driver/gpio.h"
#include "drv_ioexp.h"
#include "esp_attr.h"
#include "unity.h"

#define POWER_UP_MAGIC 0x50554631u
#define LINE_SDA 0x1u
#define LINE_SCL 0x2u

// RTC slow memory survives a chip reset and comes up random after a power cut,
// so the magic tells the first boot since power-up from every later one.
static RTC_NOINIT_ATTR uint32_t s_power_up_magic;
static RTC_NOINIT_ATTR uint32_t s_boots_since_power_up;
static RTC_NOINIT_ATTR int32_t s_cold_init;
static RTC_NOINIT_ATTR uint32_t s_cold_lines;

static esp_err_t s_this_init;

static uint32_t bus_lines(void)
{
    gpio_input_enable(APP_I2C_SDA_GPIO);
    gpio_input_enable(APP_I2C_SCL_GPIO);
    return (gpio_get_level(APP_I2C_SDA_GPIO) ? LINE_SDA : 0u) | (gpio_get_level(APP_I2C_SCL_GPIO) ? LINE_SCL : 0u);
}

static void record_power_up(uint32_t lines_before_init)
{
    if (s_power_up_magic != POWER_UP_MAGIC) {
        s_power_up_magic = POWER_UP_MAGIC;
        s_boots_since_power_up = 0;
        s_cold_lines = lines_before_init;
        s_cold_init = s_this_init;
    }
    ++s_boots_since_power_up;
    printf("boot %u since power-up: sda %u scl %u before init, init %s\n", (unsigned)s_boots_since_power_up,
           (unsigned)(lines_before_init & LINE_SDA), (unsigned)((lines_before_init & LINE_SCL) >> 1),
           esp_err_to_name(s_this_init));
    printf("first boot after power-up: sda %u scl %u before init, init %s\n", (unsigned)(s_cold_lines & LINE_SDA),
           (unsigned)((s_cold_lines & LINE_SCL) >> 1), esp_err_to_name(s_cold_init));
}

TEST_CASE("the first init since power-up answered, and a second init is refused", "[drv_ioexp]")
{
    // E7-T13 fails on the first write since power-up, so the boot that matters
    // is the one RTC memory recorded, not this one.
    TEST_ASSERT_EQUAL(ESP_OK, s_cold_init);
    TEST_ASSERT_EQUAL(ESP_OK, s_this_init);
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, drv_ioexp_init());
}

TEST_CASE("a pin past P7 is refused", "[drv_ioexp]")
{
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, drv_ioexp_set(8, true));
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, drv_ioexp_set(255, false));
}

TEST_CASE("changing one line leaves the other seven where they stood", "[drv_ioexp]")
{
    // The chip takes all eight lines in one byte, so this is the invariant the
    // shadow register exists to hold.
    TEST_ASSERT_EQUAL(ESP_OK, drv_ioexp_set(APP_IOEXP_P_AUDIO_SD, false));
    uint8_t port = 0;
    TEST_ASSERT_EQUAL(ESP_OK, drv_ioexp_read(&port));
    TEST_ASSERT_BIT_LOW(APP_IOEXP_P_AUDIO_SD, port);
    TEST_ASSERT_BIT_HIGH(APP_IOEXP_P_TOUCH_RST, port);
    TEST_ASSERT_BIT_HIGH(APP_IOEXP_P_TOF_XSHUT, port);

    TEST_ASSERT_EQUAL(ESP_OK, drv_ioexp_set(APP_IOEXP_P_TOF_XSHUT, false));
    TEST_ASSERT_EQUAL(ESP_OK, drv_ioexp_read(&port));
    TEST_ASSERT_BIT_LOW(APP_IOEXP_P_AUDIO_SD, port);
    TEST_ASSERT_BIT_LOW(APP_IOEXP_P_TOF_XSHUT, port);
    TEST_ASSERT_BIT_HIGH(APP_IOEXP_P_TOUCH_RST, port);

    TEST_ASSERT_EQUAL(ESP_OK, drv_ioexp_set(APP_IOEXP_P_TOF_XSHUT, true));
    TEST_ASSERT_EQUAL(ESP_OK, drv_ioexp_set(APP_IOEXP_P_AUDIO_SD, true));
}

TEST_CASE("read rejects a null destination", "[drv_ioexp]")
{
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, drv_ioexp_read(NULL));
}

void app_main(void)
{
    const uint32_t lines = bus_lines();
    const esp_err_t bsp = bsp_board_init();
    s_this_init = bsp == ESP_OK ? drv_ioexp_init() : bsp;
    record_power_up(lines);
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
}
