#include "drv_tof.h"

#include "VL53L1X_api.h"
#include "app_config.h"
#include "app_err.h"
#include "driver/gpio.h"
#include "drv_ioexp.h"
#include "esp_log.h"
#include "freertos/task.h"
#include "tof_platform.h"

static const char *TAG = "drv_tof";

#define TOF_DEV 0
#define DISTANCE_MODE_SHORT 1
#define TIMING_BUDGET_MS 33
#define INTER_MEASUREMENT_MS 100
// XSHUT needs 100 us low, then the chip walks its own boot sequence.
#define XSHUT_LOW_MS 10
#define BOOT_POLL_MS 2
#define BOOT_POLL_TRIES 30
#define RANGE_STATUS_OK 0

static SemaphoreHandle_t s_ready;
static bool s_running;

static void IRAM_ATTR on_ready(void *arg)
{
    (void)arg;
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(s_ready, &woken);
    if (woken == pdTRUE) {
        portYIELD_FROM_ISR();
    }
}

static esp_err_t restart_chip(void)
{
    APP_RETURN_ON_ERR(drv_ioexp_set(APP_IOEXP_P_TOF_XSHUT, false), TAG, "xshut low");
    vTaskDelay(pdMS_TO_TICKS(XSHUT_LOW_MS));
    APP_RETURN_ON_ERR(drv_ioexp_set(APP_IOEXP_P_TOF_XSHUT, true), TAG, "xshut high");
    vTaskDelay(pdMS_TO_TICKS(XSHUT_LOW_MS));
    return ESP_OK;
}

static esp_err_t wait_for_boot(void)
{
    for (int tries = 0; tries < BOOT_POLL_TRIES; ++tries) {
        uint8_t state = 0;
        if (VL53L1X_BootState(TOF_DEV, &state) == 0 && state != 0) {
            return ESP_OK;
        }
        vTaskDelay(pdMS_TO_TICKS(BOOT_POLL_MS));
    }
    return ESP_ERR_NOT_FOUND;
}

static esp_err_t attach_ready_line(void)
{
    const gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << APP_TOF_INT_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        // The chip drives the line low on a completed measurement and holds it
        // until ClearInterrupt, so the falling edge is the one event per cycle.
        .intr_type = GPIO_INTR_NEGEDGE,
    };
    APP_RETURN_ON_ERR(gpio_config(&cfg), TAG, "int pin");
    const esp_err_t installed = gpio_install_isr_service(ESP_INTR_FLAG_IRAM);
    if (installed != ESP_OK && installed != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "isr service: %s", esp_err_to_name(installed));
        return installed;
    }
    return gpio_isr_handler_add(APP_TOF_INT_GPIO, on_ready, NULL);
}

esp_err_t drv_tof_init(void)
{
    if (s_running) {
        return ESP_ERR_INVALID_STATE;
    }
    s_ready = xSemaphoreCreateBinary();
    if (s_ready == NULL) {
        return ESP_ERR_NO_MEM;
    }
    APP_RETURN_ON_ERR(tof_platform_open(), TAG, "bus");
    APP_RETURN_ON_ERR(restart_chip(), TAG, "restart");
    APP_RETURN_ON_ERR(wait_for_boot(), TAG, "boot");

    uint16_t id = 0;
    if (VL53L1X_GetSensorId(TOF_DEV, &id) != 0) {
        return ESP_ERR_NOT_FOUND;
    }
    if (VL53L1X_SensorInit(TOF_DEV) != 0 ||
        VL53L1X_SetDistanceMode(TOF_DEV, DISTANCE_MODE_SHORT) != 0 ||
        VL53L1X_SetTimingBudgetInMs(TOF_DEV, TIMING_BUDGET_MS) != 0 ||
        VL53L1X_SetInterMeasurementInMs(TOF_DEV, INTER_MEASUREMENT_MS) != 0) {
        ESP_LOGE(TAG, "sensor 0x%04X refused its ranging setup", id);
        return ESP_ERR_INVALID_RESPONSE;
    }
    APP_RETURN_ON_ERR(attach_ready_line(), TAG, "ready line");
    if (VL53L1X_StartRanging(TOF_DEV) != 0) {
        return ESP_ERR_INVALID_RESPONSE;
    }
    s_running = true;
    ESP_LOGI(TAG, "vl53l1x 0x%04X at 0x%02X, short mode, %d ms budget every %d ms", id,
             APP_TOF_I2C_ADDR, TIMING_BUDGET_MS, INTER_MEASUREMENT_MS);
    return ESP_OK;
}

esp_err_t drv_tof_read_mm(uint16_t *distance_mm, bool *status_ok)
{
    uint8_t ready = 0;
    uint8_t status = 0;
    if (!s_running || distance_mm == NULL || status_ok == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (VL53L1X_CheckForDataReady(TOF_DEV, &ready) != 0) {
        return ESP_FAIL;
    }
    if (ready == 0) {
        return ESP_ERR_TIMEOUT;
    }
    if (VL53L1X_GetDistance(TOF_DEV, distance_mm) != 0 ||
        VL53L1X_GetRangeStatus(TOF_DEV, &status) != 0) {
        return ESP_FAIL;
    }
    // Leaving the interrupt latched would stop the chip raising the next one.
    if (VL53L1X_ClearInterrupt(TOF_DEV) != 0) {
        return ESP_FAIL;
    }
    *status_ok = status == RANGE_STATUS_OK;
    return ESP_OK;
}

SemaphoreHandle_t drv_tof_ready_signal(void)
{
    return s_ready;
}
