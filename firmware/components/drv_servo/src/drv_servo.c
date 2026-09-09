#include "drv_servo.h"

#include <stdbool.h>

#include "app_config.h"
#include "app_err.h"
#include "driver/ledc.h"
#include "esp_log.h"

static const char *TAG = "drv_servo";

// drv_lcd drives the backlight from timer 0 and channel 0 of the same group.
#define SERVO_TIMER LEDC_TIMER_1
#define SERVO_CHANNEL LEDC_CHANNEL_1
#define SERVO_DUTY_BITS LEDC_TIMER_14_BIT
#define SERVO_DUTY_STEPS (1u << SERVO_DUTY_BITS)
#define SERVO_PERIOD_US (1000000u / APP_SERVO_HZ)
#define SERVO_MAX_DEG 180u

static bool s_up;
static uint32_t s_pulse_us;

static esp_err_t drive_pulse(uint32_t pulse_us)
{
    const uint32_t duty = (pulse_us * SERVO_DUTY_STEPS + SERVO_PERIOD_US / 2) / SERVO_PERIOD_US;
    APP_RETURN_ON_ERR(ledc_set_duty(LEDC_LOW_SPEED_MODE, SERVO_CHANNEL, duty), TAG, "duty");
    APP_RETURN_ON_ERR(ledc_update_duty(LEDC_LOW_SPEED_MODE, SERVO_CHANNEL), TAG, "update");
    s_pulse_us = pulse_us;
    return ESP_OK;
}

esp_err_t drv_servo_init(void)
{
    if (s_up) {
        return ESP_ERR_INVALID_STATE;
    }
    const ledc_timer_config_t timer = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .timer_num = SERVO_TIMER,
        .duty_resolution = SERVO_DUTY_BITS,
        .freq_hz = APP_SERVO_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    APP_RETURN_ON_ERR(ledc_timer_config(&timer), TAG, "timer");
    const ledc_channel_config_t channel = {
        .gpio_num = APP_SERVO_PWM_GPIO,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = SERVO_CHANNEL,
        .timer_sel = SERVO_TIMER,
        .duty = 0,
        .hpoint = 0,
    };
    APP_RETURN_ON_ERR(ledc_channel_config(&channel), TAG, "channel");
    s_up = true;
    ESP_LOGI(TAG, "sg90 on gpio%d, %d Hz, %u-%u us over %u steps", APP_SERVO_PWM_GPIO, APP_SERVO_HZ,
             APP_SERVO_MIN_US, APP_SERVO_MAX_US, SERVO_DUTY_STEPS);
    return ESP_OK;
}

esp_err_t drv_servo_angle(uint8_t angle_deg)
{
    if (!s_up) {
        return ESP_ERR_INVALID_STATE;
    }
    const uint32_t deg = angle_deg > SERVO_MAX_DEG ? SERVO_MAX_DEG : angle_deg;
    const uint32_t span_us = APP_SERVO_MAX_US - APP_SERVO_MIN_US;
    return drive_pulse(APP_SERVO_MIN_US + (span_us * deg + SERVO_MAX_DEG / 2) / SERVO_MAX_DEG);
}

esp_err_t drv_servo_release(void)
{
    if (!s_up) {
        return ESP_ERR_INVALID_STATE;
    }
    return drive_pulse(0);
}

uint32_t drv_servo_pulse_us(void)
{
    return s_pulse_us;
}
