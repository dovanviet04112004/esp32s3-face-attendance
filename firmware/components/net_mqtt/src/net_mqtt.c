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
// A sender may sit in one esp-mqtt write for its 10 s network timeout.
#define STOP_LOCK_WAIT_MS 15000
#define STOP_WAKE_MS 50

extern const char broker_ca_pem_start[] asm("_binary_broker_ca_crt_start");

typedef struct {
    esp_mqtt_client_handle_t client;
    net_mqtt_config_t config;
    int awaited_msg;
    bool up;
    bool stopping;
    uint32_t disconnects;
    char device_id[STORAGE_DEVICE_ID_CAP];
    char will_topic[GEN_TOPIC_MAX_LEN];
} link_t;

typedef struct {
    gen_topic_id_t topic;
    size_t len;
} inbox_t;

static link_t s_link;
// Created once and never deleted: a sender may still hold them while a client is torn down.
static SemaphoreHandle_t s_send_lock;
static SemaphoreHandle_t s_acked;
static char *s_inbox_buf;
static inbox_t s_inbox;

static esp_err_t make_process_objects(void)
{
    if (s_send_lock == NULL) {
        s_send_lock = xSemaphoreCreateMutex();
    }
    if (s_acked == NULL) {
        s_acked = xSemaphoreCreateBinary();
    }
    if (s_inbox_buf == NULL) {
        s_inbox_buf = heap_caps_malloc(NET_MQTT_MESSAGE_CAP, MALLOC_CAP_SPIRAM);
    }
    return s_send_lock != NULL && s_acked != NULL && s_inbox_buf != NULL ? ESP_OK : ESP_ERR_NO_MEM;
}

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

// mqtt_pass overrides on a bench broker; a shipped kiosk has only its ticket (KEHOACH 6.2.1).
static net_mqtt_login_t password(char *out, size_t cap)
{
    if (setting(NVS_PASS, out, cap, NULL) == ESP_OK) {
        return NET_MQTT_LOGIN_OVERRIDE;
    }
    if (setting(STORAGE_KEY_TICKET, out, cap, NULL) == ESP_OK) {
        return NET_MQTT_LOGIN_TICKET;
    }
    return NET_MQTT_LOGIN_NONE;
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

static void tell_state(bool up)
{
    if (s_link.config.on_state != NULL) {
        s_link.config.on_state(up, s_link.config.ctx);
    }
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
    if (!s_link.stopping) {
        tell_state(true);
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
    tell_state(false);
}

static void on_published(int msg_id)
{
    if (s_link.awaited_msg != 0 && msg_id == s_link.awaited_msg) {
        xSemaphoreGive(s_acked);
    }
}

static gen_topic_id_t topic_of(const esp_mqtt_event_handle_t event)
{
    char topic[GEN_TOPIC_MAX_LEN] = { 0 };
    if (event->topic_len <= 0 || (size_t)event->topic_len >= sizeof(topic)) {
        return GEN_TOPIC_NONE;
    }
    memcpy(topic, event->topic, (size_t)event->topic_len);
    const gen_topic_id_t id = gen_topic_classify(topic, s_link.device_id);
    if (id == GEN_TOPIC_NONE) {
        ESP_LOGW(TAG, "message on an unknown topic %s", topic);
    }
    return id;
}

// A payload past the esp-mqtt buffer arrives in pieces, and only the first names its topic.
static void on_data(const esp_mqtt_event_handle_t event)
{
    if (s_link.config.on_message == NULL || event->data_len < 0 || event->total_data_len < 0) {
        return;
    }
    const size_t total = (size_t)event->total_data_len;
    const size_t at = (size_t)event->current_data_offset;
    const size_t len = (size_t)event->data_len;
    if (at == 0) {
        s_inbox.topic = topic_of(event);
        s_inbox.len = 0;
        if (s_inbox.topic != GEN_TOPIC_NONE && len == total) {
            s_link.config.on_message(s_inbox.topic, event->data, len, s_link.config.ctx);
            s_inbox.topic = GEN_TOPIC_NONE;
            return;
        }
        if (s_inbox.topic != GEN_TOPIC_NONE && total > NET_MQTT_MESSAGE_CAP) {
            ESP_LOGE(TAG, "message of %u B will not fit %d B, dropped", (unsigned)total,
                     NET_MQTT_MESSAGE_CAP);
            s_inbox.topic = GEN_TOPIC_NONE;
        }
    }
    if (s_inbox.topic == GEN_TOPIC_NONE || event->data == NULL || at != s_inbox.len ||
        at + len > NET_MQTT_MESSAGE_CAP) {
        return;
    }
    memcpy(s_inbox_buf + at, event->data, len);
    s_inbox.len = at + len;
    if (s_inbox.len == total) {
        s_link.config.on_message(s_inbox.topic, s_inbox_buf, total, s_link.config.ctx);
        s_inbox.topic = GEN_TOPIC_NONE;
    }
}

static void on_error(const esp_mqtt_event_handle_t event)
{
    const esp_mqtt_error_codes_t *why = event->error_handle;
    if (why == NULL || why->error_type != MQTT_ERROR_TYPE_CONNECTION_REFUSED) {
        ESP_LOGW(TAG, "transport error");
        return;
    }
    ESP_LOGW(TAG, "broker refused the login, code %d", (int)why->connect_return_code);
    if (s_link.config.on_refused != NULL) {
        s_link.config.on_refused(s_link.config.ctx);
    }
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
    case MQTT_EVENT_ERROR: on_error(event); break;
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
    const bool has_pass = password(pass, TOKEN_CAP) != NET_MQTT_LOGIN_NONE;

    s_link.config = config != NULL ? *config : (net_mqtt_config_t){ 0 };
    if (make_process_objects() != ESP_OK) {
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
        return running;
    }
    ESP_LOGI(TAG, "dialling %s", uri);
    return ESP_OK;
}

// A sender waiting on an ack holds the lock, so it is woken until it lets go.
static bool take_lock_from_waiter(void)
{
    for (uint32_t waited_ms = 0; waited_ms < STOP_LOCK_WAIT_MS; waited_ms += STOP_WAKE_MS) {
        xSemaphoreGive(s_acked);
        if (xSemaphoreTake(s_send_lock, pdMS_TO_TICKS(STOP_WAKE_MS)) == pdTRUE) {
            return true;
        }
    }
    return false;
}

esp_err_t net_mqtt_stop(void)
{
    if (s_link.client == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    s_link.stopping = true;
    // A punch taken from here on is stamped offline (KEHOACH 6.2.5).
    tell_state(false);
    if (!take_lock_from_waiter()) {
        s_link.stopping = false;
        ESP_LOGE(TAG, "a sender kept the link for %d ms, not stopped", STOP_LOCK_WAIT_MS);
        tell_state(s_link.up);
        return ESP_ERR_TIMEOUT;
    }
    if (s_link.up) {
        esp_mqtt_client_publish(s_link.client, s_link.will_topic, STATUS_OFFLINE, 0,
                                GEN_TOPIC_STATUS_QOS, GEN_TOPIC_STATUS_RETAIN);
        vTaskDelay(pdMS_TO_TICKS(STOP_DRAIN_MS));
    }
    esp_mqtt_client_stop(s_link.client);
    esp_mqtt_client_destroy(s_link.client);
    memset(&s_link, 0, sizeof(s_link));
    s_inbox.topic = GEN_TOPIC_NONE;
    xSemaphoreTake(s_acked, 0);
    xSemaphoreGive(s_send_lock);
    return ESP_OK;
}

net_mqtt_login_t net_mqtt_login(void)
{
    char *scratch = heap_caps_calloc(1, TOKEN_CAP, MALLOC_CAP_SPIRAM);
    if (scratch == NULL) {
        return NET_MQTT_LOGIN_NONE;
    }
    const net_mqtt_login_t login = password(scratch, TOKEN_CAP);
    heap_caps_free(scratch);
    return login;
}

bool net_mqtt_is_up(void)
{
    return s_link.up && !s_link.stopping;
}

uint32_t net_mqtt_disconnects(void)
{
    return s_link.disconnects;
}

// The client is checked under s_send_lock, the lock net_mqtt_stop takes to tear it down.
static esp_err_t send_locked(gen_topic_id_t topic, const char *payload, size_t len,
                             uint32_t timeout_ms)
{
    if (s_link.client == NULL || !net_mqtt_is_up()) {
        return ESP_ERR_INVALID_STATE;
    }
    char name[GEN_TOPIC_MAX_LEN];
    if (!gen_topic_build(topic, s_link.device_id, name, sizeof(name))) {
        return ESP_ERR_INVALID_SIZE;
    }
    const uint8_t qos = gen_topic_qos(topic);
    xSemaphoreTake(s_acked, 0);
    s_link.awaited_msg = 0;
    const int msg_id = esp_mqtt_client_publish(s_link.client, name, payload, (int)len, qos,
                                               gen_topic_retain(topic));
    if (msg_id < 0) {
        return ESP_FAIL;
    }
    // QoS 0 has no acknowledgement, so waiting on one would always time out.
    if (qos == 0) {
        return ESP_OK;
    }
    s_link.awaited_msg = msg_id;
    const bool acked = xSemaphoreTake(s_acked, pdMS_TO_TICKS(timeout_ms)) == pdTRUE;
    s_link.awaited_msg = 0;
    if (!acked) {
        return ESP_ERR_TIMEOUT;
    }
    // net_mqtt_stop wakes a waiter too, and that wake is not an ack.
    return s_link.stopping ? ESP_ERR_INVALID_STATE : ESP_OK;
}

esp_err_t net_mqtt_publish(gen_topic_id_t topic, const char *payload, size_t len,
                           uint32_t timeout_ms)
{
    if (payload == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_send_lock == NULL || !net_mqtt_is_up()) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_send_lock, pdMS_TO_TICKS(LOCK_WAIT_MS)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    const esp_err_t err = send_locked(topic, payload, len, timeout_ms);
    xSemaphoreGive(s_send_lock);
    return err;
}
