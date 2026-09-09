#include <stdbool.h>
#include <stdint.h>

#include "app_config.h"
#include "driver/gpio.h"
#include "drv_servo.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "unity.h"

#define PERIOD_US (1000000 / APP_SERVO_HZ)
#define WINDOW_US (PERIOD_US * 10)
#define PULSE_TOLERANCE_US 40
#define PERIOD_TOLERANCE_US 200
#define ARRIVE_MS 400
#define HOLD_MS 700
#define SWEEP_STEP_DEG 45
#define MAX_DEG 180

typedef struct {
    int rises;
    int falls;
    uint32_t high_us;
    uint32_t period_us;
} pulse_t;

static pulse_t watch_pin(void)
{
    // Reading the pad back while LEDC drives it shows what the wire carries, not the duty register.
    pulse_t p = { 0 };
    int64_t first_rise = 0;
    int64_t last_rise = 0;
    int64_t high_total = 0;
    int last_level = gpio_get_level(APP_SERVO_PWM_GPIO);
    const int64_t deadline = esp_timer_get_time() + WINDOW_US;
    while (esp_timer_get_time() < deadline) {
        const int level = gpio_get_level(APP_SERVO_PWM_GPIO);
        if (level == last_level) {
            continue;
        }
        const int64_t now = esp_timer_get_time();
        if (level) {
            first_rise = p.rises == 0 ? now : first_rise;
            last_rise = now;
            ++p.rises;
        } else if (last_rise != 0) {
            high_total += now - last_rise;
            ++p.falls;
        }
        last_level = level;
    }
    p.high_us = p.falls > 0 ? (uint32_t)(high_total / p.falls) : 0;
    p.period_us = p.rises > 1 ? (uint32_t)((last_rise - first_rise) / (p.rises - 1)) : 0;
    return p;
}

TEST_CASE("the pin rests low with no pulse until an angle is asked for", "[drv_servo]")
{
    TEST_ASSERT_EQUAL(ESP_OK, gpio_input_enable(APP_SERVO_PWM_GPIO));
    printf("gpio%d reads %d with nothing driving it\n", APP_SERVO_PWM_GPIO, gpio_get_level(APP_SERVO_PWM_GPIO));
    TEST_ASSERT_EQUAL(ESP_OK, drv_servo_init());
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, drv_servo_init());
    TEST_ASSERT_EQUAL(0, drv_servo_pulse_us());
    const pulse_t idle = watch_pin();
    printf("idle: %d rises, level %d\n", idle.rises, gpio_get_level(APP_SERVO_PWM_GPIO));
    TEST_ASSERT_EQUAL(0, idle.rises);
    TEST_ASSERT_EQUAL(0, gpio_get_level(APP_SERVO_PWM_GPIO));
}

TEST_CASE("three angles put three pulse widths on the pin at 50 Hz", "[drv_servo]")
{
    const uint8_t angles[] = { 0, 90, MAX_DEG };
    for (size_t i = 0; i < sizeof(angles); ++i) {
        TEST_ASSERT_EQUAL(ESP_OK, drv_servo_angle(angles[i]));
        vTaskDelay(pdMS_TO_TICKS(ARRIVE_MS));
        const pulse_t p = watch_pin();
        printf("%3u deg: asked %4u us, pin %4u us high every %5u us over %d pulses\n", angles[i],
               (unsigned)drv_servo_pulse_us(), (unsigned)p.high_us, (unsigned)p.period_us, p.falls);
        TEST_ASSERT_GREATER_THAN(1, p.rises);
        TEST_ASSERT_UINT32_WITHIN(PULSE_TOLERANCE_US, drv_servo_pulse_us(), p.high_us);
        TEST_ASSERT_UINT32_WITHIN(PERIOD_TOLERANCE_US, PERIOD_US, p.period_us);
    }
}

TEST_CASE("the arm sweeps end to end and goes limp on release", "[drv_servo]")
{
    printf("watch the arm: 0 to %d and back in %d degree steps\n", MAX_DEG, SWEEP_STEP_DEG);
    for (int deg = 0; deg <= MAX_DEG; deg += SWEEP_STEP_DEG) {
        TEST_ASSERT_EQUAL(ESP_OK, drv_servo_angle((uint8_t)deg));
        vTaskDelay(pdMS_TO_TICKS(HOLD_MS));
    }
    for (int deg = MAX_DEG; deg >= 0; deg -= SWEEP_STEP_DEG) {
        TEST_ASSERT_EQUAL(ESP_OK, drv_servo_angle((uint8_t)deg));
        vTaskDelay(pdMS_TO_TICKS(HOLD_MS));
    }
    TEST_ASSERT_EQUAL(ESP_OK, drv_servo_release());
    TEST_ASSERT_EQUAL(0, drv_servo_pulse_us());
    const pulse_t released = watch_pin();
    printf("released: %d rises, level %d\n", released.rises, gpio_get_level(APP_SERVO_PWM_GPIO));
    TEST_ASSERT_EQUAL(0, released.rises);
    printf("main task stack left %u bytes\n", (unsigned)uxTaskGetStackHighWaterMark(NULL));
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
