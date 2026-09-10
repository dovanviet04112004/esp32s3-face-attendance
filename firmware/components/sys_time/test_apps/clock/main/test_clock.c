#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "bsp_board.h"
#include "esp_attr.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sys_time.h"
#include "unity.h"

#define TICK_WAIT_MS 2200
#define TICK_MIN_MS 1500
#define TICK_MAX_MS 3000
#define YEAR_FLOOR 2025
#define POWER_UP_MAGIC 0x54494D45
#define SNTP_HOST "pool.ntp.org"

// Survives a soft reset and dies with the power, so the first boot after the
// mains come back can hand its result to a later run (KEHOACH 6.2.5).
static RTC_NOINIT_ATTR uint32_t s_power_up_magic;
static RTC_NOINIT_ATTR int s_power_up_source;
static RTC_NOINIT_ATTR int64_t s_power_up_ms;

// Unity keeps one process across cases, so every case brings the clock up for
// itself and tolerates the call that already happened.
static void clock_up(void)
{
    const esp_err_t bus = bsp_board_init();
    TEST_ASSERT_TRUE(bus == ESP_OK || bus == ESP_ERR_INVALID_STATE);
    const esp_err_t clock = sys_time_init(true);
    TEST_ASSERT_TRUE(clock == ESP_OK || clock == ESP_ERR_INVALID_STATE);
}

TEST_CASE("the first boot after power up records what the rtc kept", "[sys_time]")
{
    const bool cold = s_power_up_magic != POWER_UP_MAGIC;
    clock_up();
    if (cold) {
        s_power_up_magic = POWER_UP_MAGIC;
        s_power_up_source = (int)sys_time_source();
        s_power_up_ms = sys_time_now_ms();
        printf("first boot since power up: source %d, clock %lld ms\n", s_power_up_source,
               s_power_up_ms);
    } else {
        printf("cold boot said source %d, clock %lld ms\n", s_power_up_source, s_power_up_ms);
    }
    TEST_ASSERT_NOT_EQUAL(SYS_TIME_SOURCE_NONE, s_power_up_source);
    TEST_ASSERT_TRUE(s_power_up_ms > 0);
}

TEST_CASE("init is refused twice and the source survives it", "[sys_time]")
{
    clock_up();
    const sys_time_source_t before_second = sys_time_source();
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, sys_time_init(true));
    TEST_ASSERT_EQUAL(before_second, sys_time_source());
}

TEST_CASE("the clock advances in step with the cpu timer", "[sys_time]")
{
    clock_up();
    const int64_t first = sys_time_now_ms();
    vTaskDelay(pdMS_TO_TICKS(TICK_WAIT_MS));
    const int64_t second = sys_time_now_ms();
    const int64_t moved = second - first;
    printf("clock moved %lld ms across a %d ms wait\n", moved, TICK_WAIT_MS);
    TEST_ASSERT_GREATER_THAN(TICK_MIN_MS, (int)moved);
    TEST_ASSERT_LESS_THAN(TICK_MAX_MS, (int)moved);
}

TEST_CASE("the year the rtc carries is a year this project can have", "[sys_time]")
{
    clock_up();
    const time_t seconds = (time_t)(sys_time_now_ms() / 1000);
    struct tm parts;
    gmtime_r(&seconds, &parts);
    printf("rtc reads %04d-%02d-%02d %02d:%02d:%02d utc\n", parts.tm_year + 1900, parts.tm_mon + 1,
           parts.tm_mday, parts.tm_hour, parts.tm_min, parts.tm_sec);
    TEST_ASSERT_GREATER_OR_EQUAL(YEAR_FLOOR, parts.tm_year + 1900);
}

TEST_CASE("writing the rtc back leaves the clock where it stood", "[sys_time]")
{
    clock_up();
    const int64_t before_write = sys_time_now_ms();
    TEST_ASSERT_EQUAL(ESP_OK, sys_time_write_rtc());
    const int64_t after_write = sys_time_now_ms();
    printf("write_rtc took %lld ms of clock\n", after_write - before_write);
    TEST_ASSERT_TRUE(after_write >= before_write);
    TEST_ASSERT_LESS_THAN(1500, (int)(after_write - before_write));
}

TEST_CASE("sntp needs a netif, and refusing it leaves the clock alone", "[sys_time]")
{
    clock_up();
    const int64_t before_call = sys_time_now_ms();
    const esp_err_t err = sys_time_sync_start(SNTP_HOST, NULL, NULL);
    printf("sync_start without wifi: %s\n", esp_err_to_name(err));
    TEST_ASSERT_TRUE(err == ESP_OK || err == ESP_ERR_INVALID_STATE);
    TEST_ASSERT_TRUE(sys_time_now_ms() >= before_call);
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, sys_time_sync_start(NULL, NULL, NULL));
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
