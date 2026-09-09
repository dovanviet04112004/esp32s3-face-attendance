#include "app_config.h"
#include "bsp_board.h"
#include "drv_ioexp.h"
#include "drv_tof.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "unity.h"

#define READY_WAIT_MS 400
#define SAMPLE_COUNT 20
#define SAMPLE_GAP_MS 120
#define RANGE_FLOOR_MM 20
#define RANGE_CEILING_MM 1400
#define SIGNAL_WAIT_MS 500

static const char *TAG = "test_ranging";

TEST_CASE("the sensor boots and refuses a second init", "[drv_tof]")
{
    TEST_ASSERT_EQUAL(ESP_OK, bsp_board_init());
    TEST_ASSERT_EQUAL(ESP_OK, drv_ioexp_init());
    TEST_ASSERT_EQUAL(ESP_OK, drv_tof_init());
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, drv_tof_init());
}

TEST_CASE("a measurement completes and lands inside the short mode range", "[drv_tof]")
{
    uint16_t distance_mm = 0;
    bool status_ok = false;
    esp_err_t err = ESP_ERR_TIMEOUT;
    const int64_t deadline = esp_timer_get_time() + READY_WAIT_MS * 1000;

    while (err == ESP_ERR_TIMEOUT && esp_timer_get_time() < deadline) {
        err = drv_tof_read_mm(&distance_mm, &status_ok);
        if (err == ESP_ERR_TIMEOUT) {
            vTaskDelay(pdMS_TO_TICKS(SAMPLE_GAP_MS));
        }
    }
    TEST_ASSERT_EQUAL(ESP_OK, err);
    printf("distance %u mm, status %s\n", (unsigned)distance_mm, status_ok ? "ok" : "unreliable");
    TEST_ASSERT_TRUE(distance_mm >= RANGE_FLOOR_MM && distance_mm <= RANGE_CEILING_MM);
}

TEST_CASE("the ready line fires once per measurement", "[drv_tof]")
{
    // The semaphore proves the GPIO3 wiring, which polling CheckForDataReady
    // over i2c would pass even with the line disconnected.
    SemaphoreHandle_t ready = drv_tof_ready_signal();
    TEST_ASSERT_NOT_NULL(ready);
    int signalled = 0;
    for (int i = 0; i < SAMPLE_COUNT; ++i) {
        if (xSemaphoreTake(ready, pdMS_TO_TICKS(SIGNAL_WAIT_MS)) == pdTRUE) {
            ++signalled;
            uint16_t distance_mm = 0;
            bool status_ok = false;
            if (drv_tof_read_mm(&distance_mm, &status_ok) == ESP_OK) {
                ESP_LOGI(TAG, "irq %d: %u mm, status %s", signalled, (unsigned)distance_mm,
                         status_ok ? "ok" : "unreliable");
            }
        }
    }
    printf("ready line fired %d of %d expected\n", signalled, SAMPLE_COUNT);
    TEST_ASSERT_GREATER_THAN_INT(SAMPLE_COUNT / 2, signalled);
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
