#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "net_wifi.h"
#include "sys_storage.h"
#include "unity.h"

#define JOIN_TIMEOUT_MS 20000
#define SSID_CAP 33
#define DROP_WAIT_MS 3000

static void storage_up(void)
{
    const esp_err_t err = sys_storage_init();
    TEST_ASSERT_TRUE(err == ESP_OK || err == ESP_ERR_INVALID_STATE);
}

TEST_CASE("credentials come from the wifi namespace, not from the driver", "[net_wifi]")
{
    storage_up();
    char ssid[SSID_CAP] = { 0 };
    const esp_err_t err = sys_storage_get_str(STORAGE_NS_WIFI, "ssid", ssid, sizeof(ssid));
    if (err != ESP_OK) {
        TEST_IGNORE_MESSAGE("no ssid in nvs: provision wifi.ssid and wifi.pass first");
    }
    printf("ssid in nvs: %s\n", ssid);
    TEST_ASSERT_GREATER_THAN(0, (int)strlen(ssid));
}

TEST_CASE("the station joins the stored access point and takes an address", "[net_wifi]")
{
    storage_up();
    const esp_err_t started = net_wifi_start();
    if (started == ESP_ERR_NOT_FOUND) {
        TEST_IGNORE_MESSAGE("no credentials in nvs");
    }
    TEST_ASSERT_TRUE(started == ESP_OK || started == ESP_ERR_INVALID_STATE);
    const int64_t t0 = esp_timer_get_time();
    const esp_err_t joined = net_wifi_wait_connected(JOIN_TIMEOUT_MS);
    printf("join took %lld ms, %" PRIu32 " disconnect(s)\n", (esp_timer_get_time() - t0) / 1000,
           net_wifi_disconnects());
    TEST_ASSERT_EQUAL(ESP_OK, joined);
    TEST_ASSERT_TRUE(net_wifi_is_connected());
}

TEST_CASE("a second start is refused and the link stays up", "[net_wifi]")
{
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, net_wifi_start());
    TEST_ASSERT_TRUE(net_wifi_is_connected());
}

TEST_CASE("waiting on a live link returns at once", "[net_wifi]")
{
    const int64_t t0 = esp_timer_get_time();
    TEST_ASSERT_EQUAL(ESP_OK, net_wifi_wait_connected(JOIN_TIMEOUT_MS));
    const int64_t waited_ms = (esp_timer_get_time() - t0) / 1000;
    printf("wait on a live link took %lld ms\n", waited_ms);
    TEST_ASSERT_LESS_THAN(50, (int)waited_ms);
}

// Nothing here can switch the access point off, so the count is the evidence:
// a link that never dropped has none, and the driver reports its own retries.
TEST_CASE("the link holds for a few seconds without a new disconnect", "[net_wifi]")
{
    const uint32_t before_wait = net_wifi_disconnects();
    vTaskDelay(pdMS_TO_TICKS(DROP_WAIT_MS));
    printf("disconnects %" PRIu32 " then %" PRIu32 " across %d ms\n", before_wait,
           net_wifi_disconnects(), DROP_WAIT_MS);
    TEST_ASSERT_EQUAL(before_wait, net_wifi_disconnects());
    TEST_ASSERT_TRUE(net_wifi_is_connected());
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
