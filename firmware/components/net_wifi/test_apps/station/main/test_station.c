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
#define REFUSE_TIMEOUT_MS 20000
#define DROP_WAIT_MS 3000
#define WRONG_PASS "not-the-passphrase-0"
#define NOWHERE_SSID "kiosk-test-no-such-network"

static char s_home[NET_WIFI_SSID_CAP];

static void storage_up(void)
{
    const esp_err_t err = sys_storage_init();
    TEST_ASSERT_TRUE(err == ESP_OK || err == ESP_ERR_INVALID_STATE);
}

static size_t saved_count(void)
{
    char names[NET_WIFI_SAVED_CAP][NET_WIFI_SSID_CAP];
    return net_wifi_saved(names, NET_WIFI_SAVED_CAP);
}

TEST_CASE("the station joins the newest saved network and takes an address", "[net_wifi]")
{
    storage_up();
    const esp_err_t started = net_wifi_start();
    if (started == ESP_ERR_NOT_FOUND) {
        TEST_IGNORE_MESSAGE("no saved network: provision wifi.ssid and wifi.pass first");
    }
    TEST_ASSERT_TRUE(started == ESP_OK || started == ESP_ERR_INVALID_STATE);
    const int64_t t0 = esp_timer_get_time();
    const esp_err_t joined = net_wifi_wait_connected(JOIN_TIMEOUT_MS);
    printf("join took %lld ms, %" PRIu32 " disconnect(s)\n", (esp_timer_get_time() - t0) / 1000,
           net_wifi_disconnects());
    TEST_ASSERT_EQUAL(ESP_OK, joined);
    char names[NET_WIFI_SAVED_CAP][NET_WIFI_SSID_CAP];
    const size_t count = net_wifi_saved(names, NET_WIFI_SAVED_CAP);
    TEST_ASSERT_GREATER_THAN(0, (int)count);
    TEST_ASSERT_EQUAL(ESP_OK, net_wifi_ssid(s_home, sizeof(s_home)));
    printf("on %s, %u network(s) saved\n", s_home, (unsigned)count);
    TEST_ASSERT_EQUAL_STRING(names[0], s_home);
}

TEST_CASE("the console's single-network keys are folded into wifi/saved", "[net_wifi]")
{
    char ssid[NET_WIFI_SSID_CAP] = { 0 };
    TEST_ASSERT_NOT_EQUAL(ESP_OK, sys_storage_get_str(STORAGE_NS_WIFI, "ssid", ssid, sizeof(ssid)));
    TEST_ASSERT_NOT_EQUAL(ESP_OK, sys_storage_get_str(STORAGE_NS_WIFI, "pass", ssid, sizeof(ssid)));
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

TEST_CASE("the info page describes the network in use", "[net_wifi]")
{
    net_wifi_info_t info;
    TEST_ASSERT_EQUAL(ESP_OK, net_wifi_info(&info));
    printf("%s at %d dBm, ip %s, security %d\n", info.ssid, info.rssi_dbm, info.ip, (int)info.security);
    TEST_ASSERT_EQUAL_STRING(s_home, info.ssid);
    TEST_ASSERT_LESS_THAN(0, info.rssi_dbm);
    TEST_ASSERT_GREATER_THAN(6, (int)strlen(info.ip));
}

TEST_CASE("a sweep lists each name once, strongest first, the one in use marked saved", "[net_wifi]")
{
    static net_wifi_ap_t heard[NET_WIFI_SCAN_CAP];
    const size_t count = net_wifi_scan(heard, NET_WIFI_SCAN_CAP);
    TEST_ASSERT_GREATER_THAN(0, (int)count);
    int home_rows = 0;
    for (size_t i = 0; i < count; ++i) {
        printf("%2u  %4d dBm  %s%s%s\n", (unsigned)i, heard[i].rssi_dbm, heard[i].ssid,
               heard[i].open ? "  open" : "", heard[i].saved ? "  saved" : "");
        if (i > 0) {
            TEST_ASSERT_TRUE(heard[i - 1].rssi_dbm >= heard[i].rssi_dbm);
        }
        for (size_t j = 0; j < i; ++j) {
            TEST_ASSERT_NOT_EQUAL(0, strcmp(heard[i].ssid, heard[j].ssid));
        }
        if (strcmp(heard[i].ssid, s_home) == 0) {
            ++home_rows;
            TEST_ASSERT_TRUE(heard[i].saved);
        }
    }
    TEST_ASSERT_EQUAL(1, home_rows);
    TEST_ASSERT_EQUAL(ESP_OK, net_wifi_wait_connected(JOIN_TIMEOUT_MS));
}

TEST_CASE("a wrong passphrase is told apart, written nowhere, and the station goes home", "[net_wifi]")
{
    net_wifi_info_t info;
    TEST_ASSERT_EQUAL(ESP_OK, net_wifi_info(&info));
    if (info.security == NET_WIFI_SECURITY_OPEN) {
        TEST_IGNORE_MESSAGE("the saved network is open: no passphrase to get wrong");
    }
    const size_t before = saved_count();
    net_wifi_fail_t why = NET_WIFI_FAIL_NONE;
    const int64_t t0 = esp_timer_get_time();
    TEST_ASSERT_EQUAL(ESP_FAIL, net_wifi_join(s_home, WRONG_PASS, REFUSE_TIMEOUT_MS, &why));
    printf("refused in %lld ms, why %d\n", (esp_timer_get_time() - t0) / 1000, (int)why);
    TEST_ASSERT_EQUAL(NET_WIFI_FAIL_PASSWORD, why);
    TEST_ASSERT_EQUAL(ESP_OK, net_wifi_wait_connected(JOIN_TIMEOUT_MS));
    char now[NET_WIFI_SSID_CAP] = { 0 };
    TEST_ASSERT_EQUAL(ESP_OK, net_wifi_ssid(now, sizeof(now)));
    TEST_ASSERT_EQUAL_STRING(s_home, now);
    TEST_ASSERT_EQUAL(before, saved_count());
}

TEST_CASE("a name no access point answers to reads as not found", "[net_wifi]")
{
    const size_t before = saved_count();
    net_wifi_fail_t why = NET_WIFI_FAIL_NONE;
    TEST_ASSERT_EQUAL(ESP_FAIL, net_wifi_join(NOWHERE_SSID, WRONG_PASS, REFUSE_TIMEOUT_MS, &why));
    printf("why %d\n", (int)why);
    TEST_ASSERT_EQUAL(NET_WIFI_FAIL_NOT_FOUND, why);
    TEST_ASSERT_EQUAL(ESP_OK, net_wifi_wait_connected(JOIN_TIMEOUT_MS));
    TEST_ASSERT_EQUAL(before, saved_count());
}

TEST_CASE("a saved network rejoins with no passphrase typed", "[net_wifi]")
{
    net_wifi_fail_t why = NET_WIFI_FAIL_OTHER;
    TEST_ASSERT_EQUAL(ESP_OK, net_wifi_join(s_home, NULL, JOIN_TIMEOUT_MS, &why));
    TEST_ASSERT_EQUAL(NET_WIFI_FAIL_NONE, why);
    TEST_ASSERT_TRUE(net_wifi_is_connected());
}

TEST_CASE("an unsaved name needs a passphrase, and only a saved name can be forgotten", "[net_wifi]")
{
    TEST_ASSERT_EQUAL(ESP_ERR_NOT_FOUND, net_wifi_join(NOWHERE_SSID, NULL, JOIN_TIMEOUT_MS, NULL));
    TEST_ASSERT_EQUAL(ESP_ERR_NOT_FOUND, net_wifi_forget(NOWHERE_SSID));
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, net_wifi_forget(NULL));
    TEST_ASSERT_TRUE(net_wifi_is_connected());
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
