/** Wall clock for the kiosk: NTP, then the api's Date header, then the DS3231 (KEHOACH 4.5).
 *  @ctx task | blocking on the i2c bus | takes m_i2c
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define SYS_TIME_FLOOR_MS 1577836800000LL // 2020-01-01Z: a stamp below counts from boot

/** Where the current wall clock came from. */
typedef enum {
    SYS_TIME_SOURCE_NONE = 0,  // nothing yet: now_ms counts from boot
    SYS_TIME_SOURCE_RTC,       // the RTC kept time but no NTP ever set it
    SYS_TIME_SOURCE_RTC_NTP,   // ntp this boot, or an rtc ntp once set
    SYS_TIME_SOURCE_API,       // the api's Date header, no ntp yet
} sys_time_source_t;

/** Told each time NTP or the api's Date sets the clock, with the marker to persist.
 *  @ctx task | the SNTP task or the api's caller | must not block long
 *  @param rtc_ntp_set the new sys.rtc_ntp_set: whether the RTC holds an NTP time
 */
typedef void (*sys_time_synced_cb)(bool rtc_ntp_set, void *arg);

/** Read the RTC, set the system clock, and take the caller's persistent marker.
 *  @ctx task | blocking | takes m_i2c | call after bsp_board_init
 *  @param rtc_ntp_set the sys.rtc_ntp_set marker, read by the wiring layer
 *  @param on_synced told of every sync from NTP or the api, NULL for none
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND or a read error: no RTC clock, the others still sync
 */
esp_err_t sys_time_init(bool rtc_ntp_set, sys_time_synced_cb on_synced, void *arg);

/** How much the current wall clock can be trusted (KEHOACH 6.2.5 bit2).
 *  @ctx any | non-blocking
 */
sys_time_source_t sys_time_source(void);

/** Whether NTP or the api vouches for the clock, enough for a ticket's exp (KEHOACH 7.3).
 *  @ctx any | non-blocking
 */
bool sys_time_trusted(void);

/** Milliseconds since the epoch, or since boot while the source is SYS_TIME_SOURCE_NONE.
 *  @ctx any | non-blocking
 */
int64_t sys_time_now_ms(void);

/** The wall time this boot began at, which places a stamp taken with no source (KEHOACH 4.5).
 *  @ctx any | non-blocking | out = now_ms minus esp_timer ms
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE while the clock is not trusted | ESP_ERR_INVALID_ARG
 */
esp_err_t sys_time_boot_at_ms(int64_t *out);

/** Start SNTP, or ask again at once when it runs; each sync rewrites the RTC.
 *  @ctx task | non-blocking | needs a live netif, not an RTC
 *  @param server host from device.sntp_host, copied (KEHOACH 4.9)
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE without init | ESP_ERR_INVALID_ARG | an SNTP error
 */
esp_err_t sys_time_sync_start(const char *server);

/** Read an HTTP Date in the IMF-fixdate form of RFC 7231 7.1.1.1, in any letter case.
 *  @ctx any | non-blocking | epoch_ms is UTC
 *  @ret ESP_OK | ESP_ERR_INVALID_ARG not such a date, or outside what the RTC can hold
 */
esp_err_t sys_time_parse_http_date(const char *value, int64_t *epoch_ms);

/** Take the api's Date as the clock unless NTP holds it; the RTC follows (KEHOACH 4.5).
 *  @ctx task | blocking | takes m_i2c | heard_at_us: esp_timer when the header came
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE NTP holds it or no init | ESP_ERR_INVALID_ARG
 */
esp_err_t sys_time_take_http_date(const char *value, int64_t heard_at_us);

/** Set the zone every localtime call reads, records staying in UTC.
 *  @ctx task | non-blocking | posix string, where ICT-7 means UTC+7
 *  @ret ESP_OK | ESP_ERR_INVALID_ARG
 */
esp_err_t sys_time_set_zone(const char *posix_tz);

/** Overwrite the RTC from the system clock and clear its oscillator-stopped flag.
 *  @ctx task | blocking | takes m_i2c
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE without an RTC on the bus | an i2c error
 */
esp_err_t sys_time_write_rtc(void);

#ifdef __cplusplus
}
#endif
