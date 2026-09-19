#include "net_mqtt.h"

#include <string.h>

#include "app_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "mqtt_client.h"
#include "sys_storage.h"

static const char *TAG = "net_mqtt";

#define NVS_URI "mqtt_uri"
#define NVS_USER "mqtt_user"
#define NVS_PASS "mqtt_pass"
#define URI_CAP 128
#define TOKEN_CAP 1024
#define TLS_SCHEME "mqtts://"
#define STATUS_ONLINE "online"
#define STATUS_OFFLINE "offline"
#define LOCK_WAIT_MS 5000
#define STOP_DRAIN_MS 500

extern const char broker_ca_pem_start[] asm("_binary_broker_ca_crt_start");

typedef struct {
    esp_mqtt_client_handle_t client;
    net_mqtt_config_t config;
    SemaphoreHandle_t send_lock;
    SemaphoreHandle_t acked;
    int awaited_msg;
    bool up;
    uint32_t disconnects;
    char device_id[STORAGE_DEVICE_ID_CAP];
    char will_topic[GEN_TOPIC_MAX_LEN];
} link_t;

static link_t s_link;

// A key present but empty is the same as absent, so the fallback wins (KEHOACH 6.2.1).
static esp_err_t setting(const char *key, char *out, size_t cap, const char *fallback)
{
    if (sys_storage_get_str(STORAGE_NS_DEVICE, key, out, cap) != ESP_OK || out[0] == '\0') {
        if (fallback == NULL || fallback[0] == '\0') {
            return ESP_ERR_NOT_FOUND;
        }
        strlcpy(out, fallback, cap);
    }
    return ESP_OK;
}

static esp_err_t subscribe_down(void)
{
    char topic[GEN_TOPIC_MAX_LEN];
    for (size_t i = 0; i < GEN_TOPIC_DOWN_COUNT; ++i) {
        const gen_topic_id_t id = gen_topic_down_at(i);
        if (!gen_topic_build(id, s_link.device_id, topic, sizeof(topic))) {
            return ESP_ERR_INVALID_SIZE;
        }
        if (esp_mqtt_client_subscribe(s_link.client, topic, gen_topic_qos(id)) < 0) {
            ESP_LOGE(TAG, "subscribe %s failed", topic);
            return ESP_FAIL;
        }
    }
    return ESP_OK;
}

static void on_connected(void)
{
    s_link.up = true;
    esp_mqtt_client_publish(s_link.client, s_link.will_topic, STATUS_ONLINE, 0,
                            GEN_TOPIC_STATUS_QOS, GEN_TOPIC_STATUS_RETAIN);
    if (subscribe_down() != ESP_OK) {
        ESP_LOGE(TAG, "down topics unsubscribed, commands will not arrive");
    }
    ESP_LOGI(TAG, "broker up as %s", s_link.device_id);
    if (s_link.config.on_state != NULL) {
        s_link.config.on_state(true, s_link.config.ctx);
    }
}

static void on_disconnected(void)
{
    if (!s_link.up) {
        return;
    }
    s_link.up = false;
    ++s_link.disconnects;
    ESP_LOGW(TAG, "broker down, %" PRIu32 " time(s)", s_link.disconnects);
    if (s_link.config.on_state != NULL) {
        s_link.config.on_state(false, s_link.config.ctx);
    }
}

static void on_published(int msg_id)
{
    if (s_link.awaited_msg != 0 && msg_id == s_link.awaited_msg) {
        xSemaphoreGive(s_link.acked);
    }
}

static void on_data(const esp_mqtt_event_handle_t event)
{
    if (s_link.config.on_message == NULL) {
        return;
    }
    char topic[GEN_TOPIC_MAX_LEN] = { 0 };
    if (event->topic_len <= 0 || (size_t)event->topic_len >= sizeof(topic)) {
        return;
    }
    memcpy(topic, event->topic, (size_t)event->topic_len);
    const gen_topic_id_t id = gen_topic_classify(topic, s_link.device_id);
    if (id == GEN_TOPIC_NONE) {
        ESP_LOGW(TAG, "message on an unknown topic %s", topic);
        return;
    }
    s_link.config.on_message(id, event->data, (size_t)event->data_len, s_link.config.ctx);
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)base;
    const esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)data;
    switch ((esp_mqtt_event_id_t)id) {
    case MQTT_EVENT_CONNECTED: on_connected(); break;
    case MQTT_EVENT_DISCONNECTED: on_disconnected(); break;
    case MQTT_EVENT_PUBLISHED: on_published(event->msg_id); break;
    case MQTT_EVENT_DATA: on_data(event); break;
    case MQTT_EVENT_ERROR: ESP_LOGW(TAG, "transport error"); break;
    default: break;
    }
}

esp_err_t net_mqtt_start(const net_mqtt_config_t *config)
{
    if (s_link.client != NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    APP_RETURN_ON_ERR(sys_storage_device_id(s_link.device_id, sizeof(s_link.device_id)), TAG,
                      "device id");
    if (!gen_topic_status(s_link.device_id, s_link.will_topic, sizeof(s_link.will_topic))) {
        return ESP_ERR_INVALID_SIZE;
    }

    char uri[URI_CAP] = { 0 };
    APP_RETURN_ON_ERR(setting(NVS_URI, uri, sizeof(uri), CONFIG_NET_MQTT_DEFAULT_URI), TAG,
                      "broker uri");
#if CONFIG_NET_MQTT_REQUIRE_TLS
    if (strncmp(uri, TLS_SCHEME, strlen(TLS_SCHEME)) != 0) {
        ESP_LOGE(TAG, "this build takes " TLS_SCHEME " only");
        return ESP_ERR_INVALID_ARG;
    }
#endif

    char user[STORAGE_DEVICE_ID_CAP] = { 0 };
    const bool has_user = setting(NVS_USER, user, sizeof(user), s_link.device_id) == ESP_OK;
    // esp-mqtt strdups every config string, so a token this long never has to
    // hold internal ram past esp_mqtt_client_init.
    char *pass = heap_caps_calloc(1, TOKEN_CAP, MALLOC_CAP_SPIRAM);
    if (pass == NULL) {
        return ESP_ERR_NO_MEM;
    }
    const bool has_pass = setting(NVS_PASS, pass, TOKEN_CAP, NULL) == ESP_OK;

    s_link.config = config != NULL ? *config : (net_mqtt_config_t){ 0 };
    s_link.send_lock = xSemaphoreCreateMutex();
    s_link.acked = xSemaphoreCreateBinary();
    if (s_link.send_lock == NULL || s_link.acked == NULL) {
        heap_caps_free(pass);
        return ESP_ERR_NO_MEM;
    }

    const esp_mqtt_client_config_t cfg = {
        .broker = {
            .address.uri = uri,
            .verification.certificate = broker_ca_pem_start,
        },
        .credentials = {
            .username = has_user ? user : NULL,
            .client_id = s_link.device_id,
            .authentication.password = has_pass ? pass : NULL,
        },
        .session = {
            .keepalive = CONFIG_NET_MQTT_KEEPALIVE_S,
            .last_will = {
                .topic = s_link.will_topic,
                .msg = STATUS_OFFLINE,
                .qos = GEN_TOPIC_STATUS_QOS,
                .retain = GEN_TOPIC_STATUS_RETAIN,
            },
        },
    };
    s_link.client = esp_mqtt_client_init(&cfg);
    heap_caps_free(pass);
    if (s_link.client == NULL) {
        return ESP_FAIL;
    }
    APP_RETURN_ON_ERR(esp_mqtt_client_register_event(s_link.client, ESP_EVENT_ANY_ID, on_event,
                                                     NULL),
                      TAG, "register");
    const esp_err_t running = esp_mqtt_client_start(s_link.client);
    if (running != ESP_OK) {
        // esp-mqtt spawns its own task, so a failure here is the stack (KEHOACH 5.2).
        ESP_LOGE(TAG, "start: %s, internal ram %u B free, largest block %u B",
                 esp_err_to_name(running),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
        heap_caps_print_heap_info(MALLOC_CAP_INTERNAL);
        return running;
    }
    ESP_LOGI(TAG, "dialling %s, internal ram %u B free, largest block %u B", uri,
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    return ESP_OK;
}

esp_err_t net_mqtt_stop(void)
{
    if (s_link.client == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (s_link.up) {
        esp_mqtt_client_publish(s_link.client, s_link.will_topic, STATUS_OFFLINE, 0,
                                GEN_TOPIC_STATUS_QOS, GEN_TOPIC_STATUS_RETAIN);
        vTaskDelay(pdMS_TO_TICKS(STOP_DRAIN_MS));
    }
    esp_mqtt_client_stop(s_link.client);
    esp_mqtt_client_destroy(s_link.client);
    vSemaphoreDelete(s_link.send_lock);
    vSemaphoreDelete(s_link.acked);
    memset(&s_link, 0, sizeof(s_link));
    return ESP_OK;
}

bool net_mqtt_is_up(void)
{
    return s_link.up;
}

uint32_t net_mqtt_disconnects(void)
{
    return s_link.disconnects;
}

esp_err_t net_mqtt_publish(gen_topic_id_t topic, const char *payload, size_t len,
                           uint32_t timeout_ms)
{
    if (s_link.client == NULL || payload == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_link.up) {
        return ESP_ERR_INVALID_STATE;
    }
    char name[GEN_TOPIC_MAX_LEN];
    if (!gen_topic_build(topic, s_link.device_id, name, sizeof(name))) {
        return ESP_ERR_INVALID_SIZE;
    }
    if (xSemaphoreTake(s_link.send_lock, pdMS_TO_TICKS(LOCK_WAIT_MS)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    const uint8_t qos = gen_topic_qos(topic);
    xSemaphoreTake(s_link.acked, 0);
    s_link.awaited_msg = 0;
    const int msg_id = esp_mqtt_client_publish(s_link.client, name, payload, (int)len, qos,
                                               gen_topic_retain(topic));
    esp_err_t err = ESP_OK;
    if (msg_id < 0) {
        err = ESP_FAIL;
    } else if (qos > 0) {
        // QoS 0 has no acknowledgement, so waiting on one would always time out.
        s_link.awaited_msg = msg_id;
        if (xSemaphoreTake(s_link.acked, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
            err = ESP_ERR_TIMEOUT;
        }
        s_link.awaited_msg = 0;
    }
    xSemaphoreGive(s_link.send_lock);
    return err;
}
