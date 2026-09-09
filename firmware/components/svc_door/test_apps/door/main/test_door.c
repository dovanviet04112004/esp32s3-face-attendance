#include <stdbool.h>
#include <stdint.h>

#include "app_config.h"
#include "drv_servo.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "svc_door.h"
#include "unity.h"

#define SETTLE_MS 600
#define HOLD_MS 300
#define HALF_HOLD_MS 150
#define LONG_HOLD_MS 5000

static svc_door_t s_door;

static void settle(void)
{
    vTaskDelay(pdMS_TO_TICKS(SETTLE_MS));
}

TEST_CASE("a fake door records what it is told and nothing else moves", "[svc_door]")
{
    svc_door_t fake = svc_door_fake();
    TEST_ASSERT_NOT_NULL(fake);
    TEST_ASSERT_EQUAL(ESP_OK, svc_door_open(fake, HOLD_MS));
    TEST_ASSERT_TRUE(svc_door_is_open(fake));
    TEST_ASSERT_EQUAL(ESP_OK, svc_door_close(fake));
    TEST_ASSERT_FALSE(svc_door_is_open(fake));
    svc_door_fake_log_t log;
    svc_door_fake_log(fake, &log);
    TEST_ASSERT_EQUAL(1, log.open_calls);
    TEST_ASSERT_EQUAL(1, log.close_calls);
    TEST_ASSERT_EQUAL(HOLD_MS, log.last_hold_ms);
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, svc_door_open(NULL, HOLD_MS));
    TEST_ASSERT_FALSE(svc_door_is_open(NULL));
}

TEST_CASE("the servo door comes up lowered and then lets the arm go limp", "[svc_door]")
{
    TEST_ASSERT_EQUAL(ESP_OK, drv_servo_init());
    s_door = svc_door_servo();
    TEST_ASSERT_NOT_NULL(s_door);
    TEST_ASSERT_FALSE(svc_door_is_open(s_door));
    TEST_ASSERT_EQUAL(APP_SERVO_MIN_US, drv_servo_pulse_us());
    settle();
    TEST_ASSERT_EQUAL(0, drv_servo_pulse_us());
}

TEST_CASE("open raises the arm and the hold lowers and releases it on its own", "[svc_door]")
{
    TEST_ASSERT_EQUAL(ESP_OK, svc_door_open(s_door, HOLD_MS));
    TEST_ASSERT_TRUE(svc_door_is_open(s_door));
    TEST_ASSERT_GREATER_THAN_UINT32(APP_SERVO_MIN_US, drv_servo_pulse_us());
    vTaskDelay(pdMS_TO_TICKS(HOLD_MS + HALF_HOLD_MS));
    TEST_ASSERT_FALSE(svc_door_is_open(s_door));
    TEST_ASSERT_EQUAL(APP_SERVO_MIN_US, drv_servo_pulse_us());
    settle();
    TEST_ASSERT_EQUAL(0, drv_servo_pulse_us());
}

TEST_CASE("a second open while raised extends the hold", "[svc_door]")
{
    TEST_ASSERT_EQUAL(ESP_OK, svc_door_open(s_door, HOLD_MS));
    vTaskDelay(pdMS_TO_TICKS(HALF_HOLD_MS));
    TEST_ASSERT_EQUAL(ESP_OK, svc_door_open(s_door, HOLD_MS));
    vTaskDelay(pdMS_TO_TICKS(HOLD_MS - HALF_HOLD_MS + HALF_HOLD_MS / 2));
    TEST_ASSERT_TRUE(svc_door_is_open(s_door));
    vTaskDelay(pdMS_TO_TICKS(HOLD_MS));
    TEST_ASSERT_FALSE(svc_door_is_open(s_door));
    settle();
    TEST_ASSERT_EQUAL(0, drv_servo_pulse_us());
}

TEST_CASE("close drops a long hold at once", "[svc_door]")
{
    TEST_ASSERT_EQUAL(ESP_OK, svc_door_open(s_door, LONG_HOLD_MS));
    TEST_ASSERT_TRUE(svc_door_is_open(s_door));
    TEST_ASSERT_EQUAL(ESP_OK, svc_door_close(s_door));
    TEST_ASSERT_FALSE(svc_door_is_open(s_door));
    TEST_ASSERT_EQUAL(APP_SERVO_MIN_US, drv_servo_pulse_us());
    settle();
    TEST_ASSERT_EQUAL(0, drv_servo_pulse_us());
    printf("main task stack left %u bytes\n", (unsigned)uxTaskGetStackHighWaterMark(NULL));
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
