#include "net_wifi.h"

#include <string.h>

#include "app_err.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "sys_storage.h"

static const char *TAG = "net_wifi";

#define SCAN_DWELL_MIN_MS 40
#define SCAN_DWELL_MAX_MS 80

#define NVS_SSID "ssid"
#define NVS_PASS "pass"
#define SSID_CAP 33
#define PASS_CAP 65
#define CONNECTED_BIT BIT0
#define RETRY_FLOOR_MS 1000
#define RETRY_CEILING_MS 30000

static EventGroupHandle_t s_state;
static esp_timer_handle_t s_retry;
static uint32_t s_disconnects;
static uint32_t s_retry_ms = RETRY_FLOOR_MS;

static esp_err_t credentials(char *ssid, size_t ssid_cap, char *pass, size_t pass_cap)
{
    APP_RETURN_ON_ERR(sys_storage_get_str(STORAGE_NS_WIFI, NVS_SSID, ssid, ssid_cap), TAG, "ssid");
    // An ssid with no password is an open network, and the NVS error codes for
    // a missing key belong to sys_storage alone (KEHOACH 4.5.4).
    if (sys_storage_get_str(STORAGE_NS_WIFI, NVS_PASS, pass, pass_cap) != ESP_OK) {
        pass[0] = '\0';
    }
    return ESP_OK;
}

static void retry_now(void *arg)
{
    (void)arg;
    esp_wifi_connect();
}

// A closed access point and a wrong password look the same from here, so the
// retry backs off, and it waits on a timer because this runs on the event loop.
static void on_disconnect(void)
{
    xEventGroupClearBits(s_state, CONNECTED_BIT);
    ++s_disconnects;
    ESP_LOGW(TAG, "disconnected %" PRIu32 " time(s), retry in %" PRIu32 " ms", s_disconnects,
             s_retry_ms);
    esp_timer_stop(s_retry);
    esp_timer_start_once(s_retry, (uint64_t)s_retry_ms * 1000);
    s_retry_ms = s_retry_ms * 2 > RETRY_CEILING_MS ? RETRY_CEILING_MS : s_retry_ms * 2;
}

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)data;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
        return;
    }
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        on_disconnect();
        return;
    }
    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *got = (const ip_event_got_ip_t *)data;
        s_retry_ms = RETRY_FLOOR_MS;
        xEventGroupSetBits(s_state, CONNECTED_BIT);
        // Nothing resolves without a DNS server, and DHCP is the only thing handing one out.
        esp_netif_dns_info_t dns = { 0 };
        esp_netif_get_dns_info(got->esp_netif, ESP_NETIF_DNS_MAIN, &dns);
        ESP_LOGI(TAG, "connected, ip " IPSTR ", dns " IPSTR " (type %d)", IP2STR(&got->ip_info.ip),
                 IP2STR(&dns.ip.u_addr.ip4), (int)dns.ip.type);
    }
}

esp_err_t net_wifi_start(void)
{
    if (s_state != NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    char ssid[SSID_CAP] = { 0 };
    char pass[PASS_CAP] = { 0 };
    const esp_err_t stored = credentials(ssid, sizeof(ssid), pass, sizeof(pass));
    if (stored != ESP_OK) {
        ESP_LOGW(TAG, "no credentials in nvs: %s", esp_err_to_name(stored));
        return ESP_ERR_NOT_FOUND;
    }
    s_state = xEventGroupCreate();
    if (s_state == NULL) {
        return ESP_ERR_NO_MEM;
    }
    const esp_timer_create_args_t retry = { .callback = retry_now, .name = "wifi_retry" };
    APP_RETURN_ON_ERR(esp_timer_create(&retry, &s_retry), TAG, "retry timer");
    APP_RETURN_ON_ERR(esp_netif_init(), TAG, "netif");
    const esp_err_t loop = esp_event_loop_create_default();
    if (loop != ESP_OK && loop != ESP_ERR_INVALID_STATE) {
        return loop;
    }
    esp_netif_create_default_wifi_sta();
    const wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    APP_RETURN_ON_ERR(esp_wifi_init(&init), TAG, "wifi init");
    APP_RETURN_ON_ERR(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                          on_wifi_event, NULL, NULL),
                      TAG, "wifi events");
    APP_RETURN_ON_ERR(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                                          on_wifi_event, NULL, NULL),
                      TAG, "ip events");
    // Credentials live in the plan's own namespace (KEHOACH 6.2.1), so the
    // driver keeps nothing of its own across a reboot.
    APP_RETURN_ON_ERR(esp_wifi_set_storage(WIFI_STORAGE_RAM), TAG, "storage");
    wifi_config_t cfg = { 0 };
    strlcpy((char *)cfg.sta.ssid, ssid, sizeof(cfg.sta.ssid));
    strlcpy((char *)cfg.sta.password, pass, sizeof(cfg.sta.password));
    cfg.sta.threshold.authmode = pass[0] == '\0' ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
    APP_RETURN_ON_ERR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "mode");
    APP_RETURN_ON_ERR(esp_wifi_set_config(WIFI_IF_STA, &cfg), TAG, "config");
    APP_RETURN_ON_ERR(esp_wifi_start(), TAG, "start");
    ESP_LOGI(TAG, "station up for ssid %s", ssid);
    return ESP_OK;
}

esp_err_t net_wifi_wait_connected(uint32_t timeout_ms)
{
    if (s_state == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    const EventBits_t bits =
        xEventGroupWaitBits(s_state, CONNECTED_BIT, pdFALSE, pdTRUE, pdMS_TO_TICKS(timeout_ms));
    return (bits & CONNECTED_BIT) != 0 ? ESP_OK : ESP_ERR_TIMEOUT;
}

bool net_wifi_is_connected(void)
{
    return s_state != NULL && (xEventGroupGetBits(s_state) & CONNECTED_BIT) != 0;
}

size_t net_wifi_scan(net_wifi_ap_t *out, size_t cap)
{
    if (out == NULL || cap == 0 || s_state == NULL) {
        return 0;
    }
    // The radio leaves its own channel for the whole sweep, so the per-channel
    // dwell is capped to stay inside the AP's inactivity window.
    const wifi_scan_config_t sweep = {
        .scan_type = WIFI_SCAN_TYPE_ACTIVE,
        .scan_time = { .active = { .min = SCAN_DWELL_MIN_MS, .max = SCAN_DWELL_MAX_MS } },
    };
    if (esp_wifi_scan_start(&sweep, true) != ESP_OK) {
        return 0;
    }
    uint16_t heard = (uint16_t)(cap < NET_WIFI_SCAN_CAP ? cap : NET_WIFI_SCAN_CAP);
    wifi_ap_record_t found[NET_WIFI_SCAN_CAP];
    if (esp_wifi_scan_get_ap_records(&heard, found) != ESP_OK) {
        esp_wifi_clear_ap_list();
        return 0;
    }
    size_t kept = 0;
    for (uint16_t i = 0; i < heard && kept < cap; ++i) {
        if (found[i].ssid[0] == '\0') {
            continue;
        }
        strlcpy(out[kept].ssid, (const char *)found[i].ssid, sizeof(out[kept].ssid));
        out[kept].rssi_dbm = found[i].rssi;
        out[kept].open = found[i].authmode == WIFI_AUTH_OPEN;
        ++kept;
    }
    ESP_LOGI(TAG, "scan heard %u networks, kept %u", (unsigned)heard, (unsigned)kept);
    return kept;
}

esp_err_t net_wifi_join(const char *ssid, const char *pass, uint32_t timeout_ms)
{
    if (ssid == NULL || ssid[0] == '\0' || s_state == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    char kept[PASS_CAP] = { 0 };
    // A network already in NVS rejoins without anyone retyping its passphrase,
    // and the secret never leaves this layer to do it (KEHOACH 4.5.4).
    if (pass == NULL) {
        char known[SSID_CAP] = { 0 };
        if (credentials(known, sizeof(known), kept, sizeof(kept)) != ESP_OK ||
            strcmp(known, ssid) != 0) {
            return ESP_ERR_NOT_FOUND;
        }
    }
    const char *secret = pass != NULL ? pass : kept;
    wifi_config_t cfg = { 0 };
    strlcpy((char *)cfg.sta.ssid, ssid, sizeof(cfg.sta.ssid));
    strlcpy((char *)cfg.sta.password, secret, sizeof(cfg.sta.password));
    cfg.sta.threshold.authmode = secret[0] == '\0' ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
    xEventGroupClearBits(s_state, CONNECTED_BIT);
    esp_wifi_disconnect();
    APP_RETURN_ON_ERR(esp_wifi_set_config(WIFI_IF_STA, &cfg), TAG, "config");
    APP_RETURN_ON_ERR(esp_wifi_connect(), TAG, "connect");
    const esp_err_t joined = net_wifi_wait_connected(timeout_ms);
    if (joined != ESP_OK) {
        ESP_LOGW(TAG, "%s refused us, credentials not written", ssid);
        return joined;
    }
    // Only a network that answered is worth keeping: a typo written to nvs
    // locks the kiosk out of the one network it can still reach.
    APP_RETURN_ON_ERR(sys_storage_set_str(STORAGE_NS_WIFI, NVS_SSID, ssid), TAG, "ssid");
    APP_RETURN_ON_ERR(sys_storage_set_str(STORAGE_NS_WIFI, NVS_PASS, secret), TAG, "pass");
    ESP_LOGI(TAG, "joined %s and kept it", ssid);
    return ESP_OK;
}

esp_err_t net_wifi_rssi_dbm(int *out)
{
    if (out == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!net_wifi_is_connected()) {
        return ESP_ERR_INVALID_STATE;
    }
    wifi_ap_record_t ap;
    APP_RETURN_ON_ERR(esp_wifi_sta_get_ap_info(&ap), TAG, "ap info");
    *out = ap.rssi;
    return ESP_OK;
}

esp_err_t net_wifi_ssid(char *out, size_t cap)
{
    if (out == NULL || cap == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    out[0] = '\0';
    if (!net_wifi_is_connected()) {
        return ESP_ERR_INVALID_STATE;
    }
    wifi_ap_record_t ap;
    APP_RETURN_ON_ERR(esp_wifi_sta_get_ap_info(&ap), TAG, "ap info");
    strlcpy(out, (const char *)ap.ssid, cap);
    return ESP_OK;
}

uint32_t net_wifi_disconnects(void)
{
    return s_disconnects;
}
