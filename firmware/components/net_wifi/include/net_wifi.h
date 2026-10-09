/** Station mode on the networks kept in NVS, rejoining on its own (KEHOACH 7.6).
 *  @ctx task | blocking | reads and writes wifi/saved through sys_storage
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "storage_format.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Bring up the station and start joining the network used last.
 *  @ctx task | blocking | call once, after sys_storage_init
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND with no saved network, the station up for the screen to fill
 *       | ESP_ERR_INVALID_STATE | ESP_ERR_NO_MEM
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

#define NET_WIFI_SSID_CAP STORAGE_WIFI_SSID_CAP
#define NET_WIFI_PASS_CAP STORAGE_WIFI_PASS_CAP
#define NET_WIFI_SCAN_CAP 12
#define NET_WIFI_SAVED_CAP STORAGE_WIFI_SAVED_CAP
#define NET_WIFI_IP_CAP 16

/** One network the radio heard, the strongest access point of its name. */
typedef struct {
    char ssid[NET_WIFI_SSID_CAP];
    int rssi_dbm;
    bool open;                            // no passphrase needed
    bool saved;                           // in wifi/saved, so it joins with no typing
} net_wifi_ap_t;

/** Sweep the channels and fill out with the networks heard, one row per name, strongest first.
 *  @ctx task | blocking 2-4 s | never call it from ui_task, it repaints
 *  @ret how many it wrote, never more than cap
 */
size_t net_wifi_scan(net_wifi_ap_t *out, size_t cap);

/** Why a join did not take. */
typedef enum {
    NET_WIFI_FAIL_NONE = 0,
    NET_WIFI_FAIL_PASSWORD,               // the access point refused the passphrase
    NET_WIFI_FAIL_NOT_FOUND,              // no access point of that name answered
    NET_WIFI_FAIL_TIMEOUT,                // nothing decided within the wait
    NET_WIFI_FAIL_OTHER,
} net_wifi_fail_t;

/** Join a network, and keep it first in wifi/saved once it answers (KEHOACH 7.6).
 *  @ctx task | blocking up to timeout_ms | writes NVS only on success
 *  @param pass NULL joins on the passphrase wifi/saved holds for this ssid
 *  @ret ESP_OK | ESP_ERR_INVALID_ARG | ESP_ERR_NOT_FOUND unsaved with no pass | ESP_FAIL, why says
 */
esp_err_t net_wifi_join(const char *ssid, const char *pass, uint32_t timeout_ms, net_wifi_fail_t *why);

/** Drop a network and its passphrase from wifi/saved; the one in use goes at once.
 *  @ctx task | blocking | writes NVS; the station then looks for another saved network
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND for a network not saved | ESP_ERR_INVALID_ARG
 *       | ESP_ERR_INVALID_STATE without start
 */
esp_err_t net_wifi_forget(const char *ssid);

/** The names in wifi/saved, most recently joined first.
 *  @ctx any | non-blocking
 *  @ret how many it wrote, never more than cap
 */
size_t net_wifi_saved(char (*out)[NET_WIFI_SSID_CAP], size_t cap);

/** Security of an access point, as a phone names it. */
typedef enum {
    NET_WIFI_SECURITY_OPEN = 0,
    NET_WIFI_SECURITY_WEP,
    NET_WIFI_SECURITY_WPA,
    NET_WIFI_SECURITY_WPA2,
    NET_WIFI_SECURITY_WPA3,
    NET_WIFI_SECURITY_OTHER,
} net_wifi_security_t;

/** What the info page shows about the network the station is on. */
typedef struct {
    char ssid[NET_WIFI_SSID_CAP];
    int rssi_dbm;
    char ip[NET_WIFI_IP_CAP];             // dotted quad
    net_wifi_security_t security;
} net_wifi_info_t;

/** Describe the network the station is on.
 *  @ctx task | non-blocking
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE offline | ESP_ERR_INVALID_ARG
 */
esp_err_t net_wifi_info(net_wifi_info_t *out);

/** Signal strength of the access point the station is on.
 *  @ctx task | non-blocking | dBm, negative; untouched when not connected
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE offline | ESP_ERR_INVALID_ARG
 */
esp_err_t net_wifi_rssi_dbm(int *out);

/** Name of the access point the station is on, empty when it is on none.
 *  @ctx task | non-blocking
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE offline | ESP_ERR_INVALID_ARG
 */
esp_err_t net_wifi_ssid(char *out, size_t cap);

#ifdef __cplusplus
}
#endif
