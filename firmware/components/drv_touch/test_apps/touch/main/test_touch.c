#include "bsp_board.h"
#include "drv_ioexp.h"
#include "drv_touch.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "unity.h"

#define OVERSIZED_MAX 200
#define WATCH_SECONDS 8
#define WATCH_POLL_MS 50

static const char *TAG = "test_touch";

TEST_CASE("read refuses to work before init", "[drv_touch]")
{
    drv_touch_point_t points[1];
    uint8_t count = 0;
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, drv_touch_read(points, 1, &count));
}

TEST_CASE("read rejects a null buffer, a null count and a zero size", "[drv_touch]")
{
    drv_touch_point_t points[1];
    uint8_t count = 0;
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, drv_touch_read(NULL, 1, &count));
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, drv_touch_read(points, 1, NULL));
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, drv_touch_read(points, 0, &count));
}

TEST_CASE("controller opens on the shared bus", "[drv_touch]")
{
    TEST_ASSERT_EQUAL(ESP_OK, bsp_board_init());
    TEST_ASSERT_EQUAL(ESP_OK, drv_ioexp_init());
    TEST_ASSERT_EQUAL(ESP_OK, drv_touch_init());
    TEST_ASSERT_NOT_NULL(drv_touch_handle());
}

TEST_CASE("a max past the driver's own limit stays inside the buffers", "[drv_touch]")
{
    drv_touch_point_t points[OVERSIZED_MAX];
    uint8_t count = 0xFF;
    TEST_ASSERT_EQUAL(ESP_OK, drv_touch_read(points, OVERSIZED_MAX, &count));
    TEST_ASSERT_LESS_OR_EQUAL(CONFIG_ESP_LCD_TOUCH_MAX_POINTS, count);
}

TEST_CASE("an untouched panel reports no contact", "[drv_touch]")
{
    drv_touch_point_t points[1];
    uint8_t count = 0xFF;
    TEST_ASSERT_EQUAL(ESP_OK, drv_touch_read(points, 1, &count));
    TEST_ASSERT_EQUAL(0, count);
}

TEST_CASE("polling holds the bus for a whole watch window", "[drv_touch]")
{
    drv_touch_point_t points[1];
    uint8_t count = 0;
    int reports = 0;
    ESP_LOGI(TAG, "touch all four corners, watching for %d s", WATCH_SECONDS);
    // Asserts only that every read lands: a window with no finger in it is a
    // quiet pass, and the coordinates it logs are what a person reads off.
    for (int tick = 0; tick < WATCH_SECONDS * (1000 / WATCH_POLL_MS); ++tick) {
        TEST_ASSERT_EQUAL(ESP_OK, drv_touch_read(points, 1, &count));
        if (count) {
            ESP_LOGI(TAG, "touch at %u,%u", points[0].x, points[0].y);
            reports++;
        }
        vTaskDelay(pdMS_TO_TICKS(WATCH_POLL_MS));
    }
    ESP_LOGI(TAG, "%d contact report(s) in %d s", reports, WATCH_SECONDS);
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
}
