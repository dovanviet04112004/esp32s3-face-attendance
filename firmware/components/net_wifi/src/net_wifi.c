#include "net_wifi.h"

#include <limits.h>
#include <stdio.h>
#include <string.h>

#include "app_err.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "sys_storage.h"

static const char *TAG = "net_wifi";

#define SCAN_DWELL_MIN_MS 40
#define SCAN_DWELL_MAX_MS 80

#define NVS_SSID "ssid"
#define NVS_PASS "pass"
#define NVS_SAVED "saved"
#define CONNECTED_BIT BIT0
#define FAILED_BIT BIT1
#define RETRY_FLOOR_MS 1000
#define RETRY_CEILING_MS 30000
#define FAILS_BEFORE_PICK 3               // retries on one network, then the strongest saved one
#define LEAVE_SETTLE_MS 200

// The radio leaves its own channel for the whole sweep, so the per-channel
// dwell is capped to stay inside the AP's inactivity window.
static const wifi_scan_config_t kSweep = {
    .scan_type = WIFI_SCAN_TYPE_ACTIVE,
    .scan_time = { .active = { .min = SCAN_DWELL_MIN_MS, .max = SCAN_DWELL_MAX_MS } },
};

static EventGroupHandle_t s_state;
static esp_timer_handle_t s_retry;
static esp_netif_t *s_netif;
static uint32_t s_disconnects;
static uint32_t s_retry_ms = RETRY_FLOOR_MS;
// The event loop, the retry timer and the task calling in all reach these, under s_lock.
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static storage_wifi_saved_t *s_saved;      // and s_written, its NVS image, in PSRAM (KEHOACH 6.4)
static char s_target[NET_WIFI_SSID_CAP];  // the network the station is set to, empty for none
static int s_fails;                       // retries since the last address
static bool s_joining;
static bool s_picking;
static uint8_t s_reason;                  // wifi_err_reason_t of the last disconnect
static wifi_ap_record_t *s_picked;        // NET_WIFI_SCAN_CAP records in PSRAM (KEHOACH 6.4)
static wifi_ap_record_t *s_swept;
static storage_wifi_saved_t *s_written;

static int find(const storage_wifi_saved_t *saved, const char *ssid)
{
    for (int i = 0; i < saved->count; ++i) {
        if (strcmp(saved->net[i].ssid, ssid) == 0) {
            return i;
        }
    }
    return -1;
}

// The network just joined goes first, and a full list lets its oldest go (KEHOACH 7.6).
static void promote(storage_wifi_saved_t *saved, const char *ssid, const char *pass)
{
    storage_wifi_net_t entry = { 0 };
    strlcpy(entry.ssid, ssid, sizeof(entry.ssid));
    strlcpy(entry.pass, pass, sizeof(entry.pass));
    const int at = find(saved, ssid);
    const int full = STORAGE_WIFI_SAVED_CAP - 1;
    const int moved = at >= 0 ? at : (saved->count < STORAGE_WIFI_SAVED_CAP ? saved->count : full);
    memmove(&saved->net[1], &saved->net[0], (size_t)moved * sizeof(entry));
    saved->net[0] = entry;
    if (at < 0 && saved->count < STORAGE_WIFI_SAVED_CAP) {
        ++saved->count;
    }
}

static void drop(storage_wifi_saved_t *saved, int at)
{
    const int after = saved->count - at - 1;
    memmove(&saved->net[at], &saved->net[at + 1], (size_t)after * sizeof(saved->net[0]));
    --saved->count;
    memset(&saved->net[saved->count], 0, sizeof(saved->net[0]));
}

static esp_err_t write_saved(void)
{
    portENTER_CRITICAL(&s_lock);
    *s_written = *s_saved;
    portEXIT_CRITICAL(&s_lock);
    return sys_storage_set_blob(STORAGE_NS_WIFI, NVS_SAVED, s_written, sizeof(*s_written));
}

// The console and older firmware keep one network in ssid/pass; it joins the list as the newest.
static void load_saved(void)
{
    if (sys_storage_get_blob(STORAGE_NS_WIFI, NVS_SAVED, s_saved, sizeof(*s_saved)) != ESP_OK ||
        s_saved->magic != STORAGE_WIFI_SAVED_MAGIC || s_saved->count > STORAGE_WIFI_SAVED_CAP) {
        memset(s_saved, 0, sizeof(*s_saved));
        s_saved->magic = STORAGE_WIFI_SAVED_MAGIC;
    }
    char ssid[NET_WIFI_SSID_CAP] = { 0 };
    char pass[NET_WIFI_PASS_CAP] = { 0 };
    if (sys_storage_get_str(STORAGE_NS_WIFI, NVS_SSID, ssid, sizeof(ssid)) != ESP_OK || ssid[0] == '\0') {
        return;
    }
    // An ssid with no password is an open network (KEHOACH 6.2.1).
    if (sys_storage_get_str(STORAGE_NS_WIFI, NVS_PASS, pass, sizeof(pass)) != ESP_OK) {
        pass[0] = '\0';
    }
    promote(s_saved, ssid, pass);
    if (write_saved() == ESP_OK) {
        sys_storage_erase_key(STORAGE_NS_WIFI, NVS_SSID);
        sys_storage_erase_key(STORAGE_NS_WIFI, NVS_PASS);
    }
}

static esp_err_t aim(const storage_wifi_net_t *net)
{
    wifi_config_t cfg = { 0 };
    strlcpy((char *)cfg.sta.ssid, net->ssid, sizeof(cfg.sta.ssid));
    strlcpy((char *)cfg.sta.password, net->pass, sizeof(cfg.sta.password));
    cfg.sta.threshold.authmode = net->pass[0] == '\0' ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
    portENTER_CRITICAL(&s_lock);
    strlcpy(s_target, net->ssid, sizeof(s_target));
    portEXIT_CRITICAL(&s_lock);
    return esp_wifi_set_config(WIFI_IF_STA, &cfg);
}

static void retry_later(void)
{
    esp_timer_stop(s_retry);
    esp_timer_start_once(s_retry, (uint64_t)s_retry_ms * 1000);
    s_retry_ms = s_retry_ms * 2 > RETRY_CEILING_MS ? RETRY_CEILING_MS : s_retry_ms * 2;
}

// A blocking scan here would hold every other esp_timer callback, so the pick waits for SCAN_DONE.
static void retry_now(void *arg)
{
    (void)arg;
    if (net_wifi_is_connected()) {
        return;
    }
    portENTER_CRITICAL(&s_lock);
    const bool aimed = !s_joining && s_target[0] != '\0';
    const bool pick = aimed && s_fails >= FAILS_BEFORE_PICK && s_saved->count > 0;
    s_picking = pick;
    portEXIT_CRITICAL(&s_lock);
    if (!aimed) {
        return;
    }
    if (pick && esp_wifi_scan_start(&kSweep, false) == ESP_OK) {
        return;
    }
    portENTER_CRITICAL(&s_lock);
    s_picking = false;
    portEXIT_CRITICAL(&s_lock);
    if (esp_wifi_connect() != ESP_OK) {
        retry_later();
    }
}

static void pick_strongest(void)
{
    uint16_t heard = NET_WIFI_SCAN_CAP;
    if (esp_wifi_scan_get_ap_records(&heard, s_picked) != ESP_OK) {
        esp_wifi_clear_ap_list();
        heard = 0;
    }
    storage_wifi_net_t best = { 0 };
    int best_rssi = INT_MIN;
    portENTER_CRITICAL(&s_lock);
    for (uint16_t i = 0; i < heard; ++i) {
        const int at = find(s_saved, (const char *)s_picked[i].ssid);
        if (at >= 0 && s_picked[i].rssi > best_rssi) {
            best = s_saved->net[at];
            best_rssi = s_picked[i].rssi;
        }
    }
    if (best.ssid[0] != '\0') {
        s_fails = 0;
    }
    portEXIT_CRITICAL(&s_lock);
    if (best.ssid[0] == '\0') {
        ESP_LOGW(TAG, "no saved network in range, looking again in %" PRIu32 " ms", s_retry_ms);
        retry_later();
        return;
    }
    ESP_LOGI(TAG, "joining %s, the strongest saved network heard (%d dBm)", best.ssid, best_rssi);
    if (aim(&best) != ESP_OK || esp_wifi_connect() != ESP_OK) {
        retry_later();
    }
}

static void on_disconnect(const wifi_event_sta_disconnected_t *gone)
{
    xEventGroupClearBits(s_state, CONNECTED_BIT);
    ++s_disconnects;
    const uint8_t reason = gone != NULL ? gone->reason : 0;
    portENTER_CRITICAL(&s_lock);
    s_reason = reason;
    const bool joining = s_joining;
    const bool aimed = s_target[0] != '\0';
    if (!joining) {
        ++s_fails;
    }
    portEXIT_CRITICAL(&s_lock);
    // The leave a join asks for first is no answer from the network it wants.
    if (joining) {
        if (reason != WIFI_REASON_ASSOC_LEAVE) {
            xEventGroupSetBits(s_state, FAILED_BIT);
        }
        return;
    }
    if (!aimed) {
        return;
    }
    ESP_LOGW(TAG, "disconnected %" PRIu32 " time(s), reason %u, retry in %" PRIu32 " ms", s_disconnects,
             (unsigned)reason, s_retry_ms);
    retry_later();
}

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        portENTER_CRITICAL(&s_lock);
        const bool aimed = s_target[0] != '\0';
        portEXIT_CRITICAL(&s_lock);
        if (aimed) {
            esp_wifi_connect();
        }
        return;
    }
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        on_disconnect((const wifi_event_sta_disconnected_t *)data);
        return;
    }
    if (base == WIFI_EVENT && id == WIFI_EVENT_SCAN_DONE) {
        portENTER_CRITICAL(&s_lock);
        const bool mine = s_picking;
        s_picking = false;
        portEXIT_CRITICAL(&s_lock);
        if (mine) {
            pick_strongest();
        }
        return;
    }
    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *got = (const ip_event_got_ip_t *)data;
        esp_timer_stop(s_retry);
        s_retry_ms = RETRY_FLOOR_MS;
        portENTER_CRITICAL(&s_lock);
        s_fails = 0;
        portEXIT_CRITICAL(&s_lock);
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
    if (s_picked == NULL) {
        s_picked = heap_caps_calloc(NET_WIFI_SCAN_CAP, sizeof(wifi_ap_record_t), MALLOC_CAP_SPIRAM);
    }
    if (s_swept == NULL) {
        s_swept = heap_caps_calloc(NET_WIFI_SCAN_CAP, sizeof(wifi_ap_record_t), MALLOC_CAP_SPIRAM);
    }
    if (s_saved == NULL) {
        s_saved = heap_caps_calloc(1, sizeof(*s_saved), MALLOC_CAP_SPIRAM);
    }
    if (s_written == NULL) {
        s_written = heap_caps_calloc(1, sizeof(*s_written), MALLOC_CAP_SPIRAM);
    }
    if (s_picked == NULL || s_swept == NULL || s_saved == NULL || s_written == NULL) {
        return ESP_ERR_NO_MEM;
    }
    load_saved();
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
    s_netif = esp_netif_create_default_wifi_sta();
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
    APP_RETURN_ON_ERR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "mode");
    if (s_saved->count > 0) {
        APP_RETURN_ON_ERR(aim(&s_saved->net[0]), TAG, "config");
    }
    // The station runs with no network too, or the screen could neither scan nor join (KEHOACH 7.3).
    APP_RETURN_ON_ERR(esp_wifi_start(), TAG, "start");
    if (s_saved->count == 0) {
        ESP_LOGW(TAG, "no saved network: the station waits for one from the screen");
        return ESP_ERR_NOT_FOUND;
    }
    ESP_LOGI(TAG, "station up for %s, %u network(s) saved", s_saved->net[0].ssid,
             (unsigned)s_saved->count);
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

static void keep_strongest_first(net_wifi_ap_t *out, size_t count)
{
    for (size_t i = 1; i < count; ++i) {
        const net_wifi_ap_t moving = out[i];
        size_t j = i;
        for (; j > 0 && out[j - 1].rssi_dbm < moving.rssi_dbm; --j) {
            out[j] = out[j - 1];
        }
        out[j] = moving;
    }
}

size_t net_wifi_scan(net_wifi_ap_t *out, size_t cap)
{
    if (out == NULL || cap == 0 || s_state == NULL) {
        return 0;
    }
    if (esp_wifi_scan_start(&kSweep, true) != ESP_OK) {
        return 0;
    }
    uint16_t heard = NET_WIFI_SCAN_CAP;
    if (esp_wifi_scan_get_ap_records(&heard, s_swept) != ESP_OK) {
        esp_wifi_clear_ap_list();
        return 0;
    }
    size_t kept = 0;
    for (uint16_t i = 0; i < heard; ++i) {
        const char *ssid = (const char *)s_swept[i].ssid;
        if (ssid[0] == '\0') {
            continue;
        }
        size_t at = 0;
        while (at < kept && strcmp(out[at].ssid, ssid) != 0) {
            ++at;
        }
        // Several access points of one name are one network, as strong as the strongest.
        if (at < kept) {
            out[at].rssi_dbm = s_swept[i].rssi > out[at].rssi_dbm ? s_swept[i].rssi : out[at].rssi_dbm;
            continue;
        }
        if (kept == cap) {
            continue;
        }
        strlcpy(out[kept].ssid, ssid, sizeof(out[kept].ssid));
        out[kept].rssi_dbm = s_swept[i].rssi;
        out[kept].open = s_swept[i].authmode == WIFI_AUTH_OPEN;
        portENTER_CRITICAL(&s_lock);
        out[kept].saved = find(s_saved, ssid) >= 0;
        portEXIT_CRITICAL(&s_lock);
        ++kept;
    }
    keep_strongest_first(out, kept);
    ESP_LOGI(TAG, "scan heard %u access points, %u networks", (unsigned)heard, (unsigned)kept);
    return kept;
}

static net_wifi_fail_t failure_of(EventBits_t bits, uint8_t reason)
{
    if ((bits & FAILED_BIT) == 0) {
        return NET_WIFI_FAIL_TIMEOUT;
    }
    switch (reason) {
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_AUTH_EXPIRE:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_MIC_FAILURE:
    case WIFI_REASON_802_1X_AUTH_FAILED:
        return NET_WIFI_FAIL_PASSWORD;
    case WIFI_REASON_NO_AP_FOUND:
    case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY:
    case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD:
    case WIFI_REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD:
        return NET_WIFI_FAIL_NOT_FOUND;
    default:
        return NET_WIFI_FAIL_OTHER;
    }
}

// Back to the network last joined, or with hunt to the strongest saved one in range (KEHOACH 7.6).
static void return_to_saved(bool hunt)
{
    storage_wifi_net_t back = { 0 };
    portENTER_CRITICAL(&s_lock);
    const bool any = s_saved->count > 0;
    if (any) {
        back = s_saved->net[0];
    } else {
        s_target[0] = '\0';
    }
    if (any && hunt) {
        s_fails = FAILS_BEFORE_PICK;
    }
    portEXIT_CRITICAL(&s_lock);
    esp_wifi_disconnect();
    if (!any) {
        wifi_config_t none = { 0 };
        esp_wifi_set_config(WIFI_IF_STA, &none);
        return;
    }
    if (aim(&back) != ESP_OK || hunt || esp_wifi_connect() != ESP_OK) {
        retry_later();
    }
}

esp_err_t net_wifi_join(const char *ssid, const char *pass, uint32_t timeout_ms, net_wifi_fail_t *why)
{
    if (why != NULL) {
        *why = NET_WIFI_FAIL_NONE;
    }
    if (ssid == NULL || ssid[0] == '\0' || s_state == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    storage_wifi_net_t chosen = { 0 };
    strlcpy(chosen.ssid, ssid, sizeof(chosen.ssid));
    portENTER_CRITICAL(&s_lock);
    const int at = find(s_saved, ssid);
    // A saved network rejoins without anyone retyping its passphrase, which never leaves this layer.
    if (pass == NULL && at >= 0) {
        strlcpy(chosen.pass, s_saved->net[at].pass, sizeof(chosen.pass));
    }
    s_joining = pass != NULL || at >= 0;
    portEXIT_CRITICAL(&s_lock);
    if (pass == NULL && at < 0) {
        return ESP_ERR_NOT_FOUND;
    }
    if (pass != NULL) {
        strlcpy(chosen.pass, pass, sizeof(chosen.pass));
    }
    esp_timer_stop(s_retry);
    esp_wifi_disconnect();
    // The leave lands on the event loop, and its event is spent ahead of the chosen network's try.
    vTaskDelay(pdMS_TO_TICKS(LEAVE_SETTLE_MS));
    xEventGroupClearBits(s_state, CONNECTED_BIT | FAILED_BIT);
    esp_err_t err = aim(&chosen);
    if (err == ESP_OK) {
        err = esp_wifi_connect();
    }
    const EventBits_t bits = err != ESP_OK ? 0
                                           : xEventGroupWaitBits(s_state, CONNECTED_BIT | FAILED_BIT, pdFALSE,
                                                                 pdFALSE, pdMS_TO_TICKS(timeout_ms));
    const bool joined = (bits & CONNECTED_BIT) != 0;
    portENTER_CRITICAL(&s_lock);
    s_joining = false;
    const uint8_t reason = s_reason;
    if (joined) {
        promote(s_saved, chosen.ssid, chosen.pass);
    }
    portEXIT_CRITICAL(&s_lock);
    if (joined) {
        // Only a network that answered is worth keeping: a typo written to nvs
        // locks the kiosk out of the one network it can still reach.
        APP_RETURN_ON_ERR(write_saved(), TAG, "saved");
        ESP_LOGI(TAG, "joined %s and kept it", ssid);
        return ESP_OK;
    }
    if (why != NULL) {
        *why = err != ESP_OK ? NET_WIFI_FAIL_OTHER : failure_of(bits, reason);
    }
    ESP_LOGW(TAG, "%s refused us, reason %u, nothing written", ssid, (unsigned)reason);
    return_to_saved(false);
    return ESP_FAIL;
}

esp_err_t net_wifi_forget(const char *ssid)
{
    if (ssid == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_state == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    portENTER_CRITICAL(&s_lock);
    const int at = find(s_saved, ssid);
    const bool current = at >= 0 && strcmp(s_target, ssid) == 0;
    if (at >= 0) {
        drop(s_saved, at);
    }
    portEXIT_CRITICAL(&s_lock);
    if (at < 0) {
        return ESP_ERR_NOT_FOUND;
    }
    APP_RETURN_ON_ERR(write_saved(), TAG, "saved");
    ESP_LOGW(TAG, "forgot %s%s", ssid, current ? ", the network in use" : "");
    if (current) {
        return_to_saved(true);
    }
    return ESP_OK;
}

size_t net_wifi_saved(char (*out)[NET_WIFI_SSID_CAP], size_t cap)
{
    if (out == NULL || s_saved == NULL) {
        return 0;
    }
    portENTER_CRITICAL(&s_lock);
    const size_t count = s_saved->count < cap ? s_saved->count : cap;
    for (size_t i = 0; i < count; ++i) {
        strlcpy(out[i], s_saved->net[i].ssid, NET_WIFI_SSID_CAP);
    }
    portEXIT_CRITICAL(&s_lock);
    return count;
}

static net_wifi_security_t security_of(wifi_auth_mode_t mode)
{
    switch (mode) {
    case WIFI_AUTH_OPEN:
    case WIFI_AUTH_OWE:
        return NET_WIFI_SECURITY_OPEN;
    case WIFI_AUTH_WEP:
        return NET_WIFI_SECURITY_WEP;
    case WIFI_AUTH_WPA_PSK:
        return NET_WIFI_SECURITY_WPA;
    case WIFI_AUTH_WPA2_PSK:
    case WIFI_AUTH_WPA_WPA2_PSK:
    case WIFI_AUTH_WPA2_ENTERPRISE:
        return NET_WIFI_SECURITY_WPA2;
    case WIFI_AUTH_WPA3_PSK:
    case WIFI_AUTH_WPA2_WPA3_PSK:
    case WIFI_AUTH_WPA3_ENTERPRISE:
        return NET_WIFI_SECURITY_WPA3;
    default:
        return NET_WIFI_SECURITY_OTHER;
    }
}

esp_err_t net_wifi_info(net_wifi_info_t *out)
{
    if (out == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    memset(out, 0, sizeof(*out));
    if (!net_wifi_is_connected()) {
        return ESP_ERR_INVALID_STATE;
    }
    wifi_ap_record_t ap;
    APP_RETURN_ON_ERR(esp_wifi_sta_get_ap_info(&ap), TAG, "ap info");
    strlcpy(out->ssid, (const char *)ap.ssid, sizeof(out->ssid));
    out->rssi_dbm = ap.rssi;
    out->security = security_of(ap.authmode);
    esp_netif_ip_info_t ip = { 0 };
    if (s_netif != NULL && esp_netif_get_ip_info(s_netif, &ip) == ESP_OK) {
        snprintf(out->ip, sizeof(out->ip), IPSTR, IP2STR(&ip.ip));
    }
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
