/** Station mode on the credentials kept in NVS, reconnecting on its own.
 *  @ctx task | blocking | reads wifi.ssid and wifi.pass through sys_storage
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Bring up the station and start connecting to the stored access point.
 *  @ctx task | blocking | call once, after sys_storage_init
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND with no credentials | ESP_ERR_INVALID_STATE
 */
esp_err_t net_wifi_start(void);

/** Block until the station holds an address, or give up.
 *  @ctx task | blocking up to timeout_ms
 *  @ret ESP_OK | ESP_ERR_TIMEOUT | ESP_ERR_INVALID_STATE without start
 */
esp_err_t net_wifi_wait_connected(uint32_t timeout_ms);

/** Whether the station holds an address right now.
 *  @ctx any | non-blocking
 */
bool net_wifi_is_connected(void);

/** How many times the station has lost the access point since start.
 *  @ctx any | non-blocking | a rising count with no connect is a bad password
 */
uint32_t net_wifi_disconnects(void);

#define NET_WIFI_SSID_CAP 33
#define NET_WIFI_PASS_CAP 65
#define NET_WIFI_SCAN_CAP 12

/** One access point the radio heard. */
typedef struct {
    char ssid[NET_WIFI_SSID_CAP];
    int rssi_dbm;
    bool open;                            // no passphrase needed
} net_wifi_ap_t;

/** Sweep the channels and fill out with the strongest networks heard.
 *  @ctx task | blocking 2-4 s | never call it from ui_task, it repaints
 *  @ret how many it wrote, never more than cap
 */
size_t net_wifi_scan(net_wifi_ap_t *out, size_t cap);

/** Store credentials and bring the station back up on them.
 *  @ctx task | blocking | writes wifi/ssid and wifi/pass (KEHOACH 6.2.1)
 *  @ret ESP_OK | ESP_ERR_INVALID_ARG | ESP_ERR_TIMEOUT when it will not join
 */
esp_err_t net_wifi_join(const char *ssid, const char *pass, uint32_t timeout_ms);

/** Signal strength of the access point the station is on.
 *  @ctx task | non-blocking | dBm, negative; untouched when not connected
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE offline | ESP_ERR_INVALID_ARG
 */
esp_err_t net_wifi_rssi_dbm(int *out);

#ifdef __cplusplus
}
#endif
