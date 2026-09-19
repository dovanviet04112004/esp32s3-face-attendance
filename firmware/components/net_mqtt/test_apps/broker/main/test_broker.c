#include <inttypes.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "net_mqtt.h"
#include "net_wifi.h"
#include "sys_storage.h"
#include "unity.h"

#define JOIN_TIMEOUT_MS 20000
#define LINK_TIMEOUT_MS 20000
#define ACK_TIMEOUT_MS 5000
#define LOOPBACK_WAIT_MS 5000
#define POLL_MS 100
#define URI_CAP 128
#define TLS_SCHEME "mqtts://"
#define LOOPBACK_PAYLOAD "{\"cmd\":\"PING\"}"
#define HOLD_MS 3000

static atomic_int s_state_calls;
static atomic_bool s_last_state;
static atomic_int s_messages;
static gen_topic_id_t s_seen_topic;
static char s_seen_payload[64];

static void on_state(bool up, void *ctx)
{
    (void)ctx;
    atomic_store(&s_last_state, up);
    atomic_fetch_add(&s_state_calls, 1);
}

static void on_message(gen_topic_id_t topic, const char *payload, size_t len, void *ctx)
{
    (void)ctx;
    s_seen_topic = topic;
    const size_t copy = len < sizeof(s_seen_payload) - 1 ? len : sizeof(s_seen_payload) - 1;
    memcpy(s_seen_payload, payload, copy);
    s_seen_payload[copy] = '\0';
    atomic_fetch_add(&s_messages, 1);
}

static void storage_up(void)
{
    const esp_err_t err = sys_storage_init();
    TEST_ASSERT_TRUE(err == ESP_OK || err == ESP_ERR_INVALID_STATE);
}

static bool wait_for_link(uint32_t timeout_ms)
{
    for (uint32_t waited = 0; waited < timeout_ms; waited += POLL_MS) {
        if (net_mqtt_is_up()) {
            return true;
        }
        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
    }
    return net_mqtt_is_up();
}

TEST_CASE("the kiosk names itself from the efuse when nvs holds no serial", "[net_mqtt]")
{
    storage_up();
    char id[STORAGE_DEVICE_ID_CAP] = { 0 };
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_device_id(id, sizeof(id)));
    printf("device id: %s\n", id);
    TEST_ASSERT_GREATER_THAN(3, (int)strlen(id));
    TEST_ASSERT_LESS_OR_EQUAL(GEN_TOPIC_DEVICE_ID_MAX, (int)strlen(id));
}

TEST_CASE("the broker address comes from nvs and asks for tls", "[net_mqtt]")
{
    storage_up();
    char uri[URI_CAP] = { 0 };
    const esp_err_t err = sys_storage_get_str(STORAGE_NS_DEVICE, "mqtt_uri", uri, sizeof(uri));
    if (err != ESP_OK || uri[0] == '\0') {
        TEST_IGNORE_MESSAGE("no device/mqtt_uri: provision it over the console first");
    }
    printf("broker uri: %s\n", uri);
    TEST_ASSERT_EQUAL_STRING_LEN(TLS_SCHEME, uri, strlen(TLS_SCHEME));
}

TEST_CASE("a broker with no link underneath it is refused", "[net_mqtt]")
{
    storage_up();
    TEST_ASSERT_FALSE(net_mqtt_is_up());
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE,
                      net_mqtt_publish(GEN_TOPIC_HEARTBEAT, "{}", 2, ACK_TIMEOUT_MS));
}

TEST_CASE("the station joins so the broker has a route", "[net_mqtt]")
{
    storage_up();
    const esp_err_t started = net_wifi_start();
    if (started == ESP_ERR_NOT_FOUND) {
        TEST_IGNORE_MESSAGE("no wifi credentials in nvs");
    }
    TEST_ASSERT_TRUE(started == ESP_OK || started == ESP_ERR_INVALID_STATE);
    TEST_ASSERT_EQUAL(ESP_OK, net_wifi_wait_connected(JOIN_TIMEOUT_MS));
}

TEST_CASE("the link comes up over tls and reports itself once", "[net_mqtt]")
{
    atomic_store(&s_state_calls, 0);
    const net_mqtt_config_t config = { .on_state = on_state, .on_message = on_message };
    const int64_t t0 = esp_timer_get_time();
    const esp_err_t started = net_mqtt_start(&config);
    if (started == ESP_ERR_NOT_FOUND) {
        TEST_IGNORE_MESSAGE("no device/mqtt_uri in nvs");
    }
    TEST_ASSERT_EQUAL(ESP_OK, started);
    TEST_ASSERT_TRUE_MESSAGE(wait_for_link(LINK_TIMEOUT_MS), "broker refused or unreachable");
    printf("link up in %lld ms\n", (esp_timer_get_time() - t0) / 1000);
    TEST_ASSERT_EQUAL(1, atomic_load(&s_state_calls));
    TEST_ASSERT_TRUE(atomic_load(&s_last_state));
}

TEST_CASE("a second start is refused and the link stays up", "[net_mqtt]")
{
    const net_mqtt_config_t config = { .on_state = on_state };
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, net_mqtt_start(&config));
    TEST_ASSERT_TRUE(net_mqtt_is_up());
}

TEST_CASE("a qos 1 publish returns only once the broker acknowledges it", "[net_mqtt]")
{
    const char *record = "{\"deviceId\":\"probe\",\"localId\":\"1\"}";
    const int64_t t0 = esp_timer_get_time();
    const esp_err_t err = net_mqtt_publish(GEN_TOPIC_ATTENDANCE, record, strlen(record),
                                           ACK_TIMEOUT_MS);
    const int64_t waited_ms = (esp_timer_get_time() - t0) / 1000;
    printf("attendance acked in %lld ms\n", waited_ms);
    TEST_ASSERT_EQUAL(ESP_OK, err);
    TEST_ASSERT_LESS_THAN(ACK_TIMEOUT_MS, (int)waited_ms);
}

// A qos 0 topic has no acknowledgement, so a publish that waited for one would
// burn the whole timeout and still call the send healthy.
TEST_CASE("a qos 0 publish does not wait for an acknowledgement", "[net_mqtt]")
{
    TEST_ASSERT_EQUAL(0, GEN_TOPIC_HEARTBEAT_QOS);
    const char *beat = "{\"uptimeSeconds\":1}";
    const int64_t t0 = esp_timer_get_time();
    const esp_err_t err = net_mqtt_publish(GEN_TOPIC_HEARTBEAT, beat, strlen(beat),
                                           ACK_TIMEOUT_MS);
    const int64_t waited_ms = (esp_timer_get_time() - t0) / 1000;
    printf("heartbeat returned in %lld ms\n", waited_ms);
    TEST_ASSERT_EQUAL(ESP_OK, err);
    TEST_ASSERT_LESS_THAN(ACK_TIMEOUT_MS / 2, (int)waited_ms);
}

// The client subscribes to its own down topics, and the acl grants it the whole
// kiosk/{deviceId}/# subtree, so a command it publishes comes back to it.
TEST_CASE("a message on a down topic reaches the handler", "[net_mqtt]")
{
    atomic_store(&s_messages, 0);
    s_seen_payload[0] = '\0';
    TEST_ASSERT_EQUAL(ESP_OK, net_mqtt_publish(GEN_TOPIC_CMD, LOOPBACK_PAYLOAD,
                                               strlen(LOOPBACK_PAYLOAD), ACK_TIMEOUT_MS));
    for (uint32_t waited = 0; waited < LOOPBACK_WAIT_MS; waited += POLL_MS) {
        if (atomic_load(&s_messages) > 0) {
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
    }
    printf("handler saw %d message(s), topic %d, payload %s\n", atomic_load(&s_messages),
           (int)s_seen_topic, s_seen_payload);
    TEST_ASSERT_GREATER_THAN(0, atomic_load(&s_messages));
    TEST_ASSERT_EQUAL(GEN_TOPIC_CMD, s_seen_topic);
    TEST_ASSERT_EQUAL_STRING(LOOPBACK_PAYLOAD, s_seen_payload);
}

TEST_CASE("an unknown topic is refused before it reaches the wire", "[net_mqtt]")
{
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_SIZE,
                      net_mqtt_publish(GEN_TOPIC_NONE, "{}", 2, ACK_TIMEOUT_MS));
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG,
                      net_mqtt_publish(GEN_TOPIC_HEARTBEAT, NULL, 0, ACK_TIMEOUT_MS));
}

// Nothing here can switch the broker off, so the count is the evidence: a link
// that never dropped has none.
TEST_CASE("the link holds without a new disconnect", "[net_mqtt]")
{
    const uint32_t before = net_mqtt_disconnects();
    vTaskDelay(pdMS_TO_TICKS(HOLD_MS));
    printf("disconnects %" PRIu32 " then %" PRIu32 " across %d ms\n", before,
           net_mqtt_disconnects(), HOLD_MS);
    TEST_ASSERT_EQUAL(before, net_mqtt_disconnects());
    TEST_ASSERT_TRUE(net_mqtt_is_up());
}

TEST_CASE("stopping takes the link down and a second stop is refused", "[net_mqtt]")
{
    TEST_ASSERT_EQUAL(ESP_OK, net_mqtt_stop());
    TEST_ASSERT_FALSE(net_mqtt_is_up());
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, net_mqtt_stop());
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG,
                      net_mqtt_publish(GEN_TOPIC_HEARTBEAT, "{}", 2, ACK_TIMEOUT_MS));
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
