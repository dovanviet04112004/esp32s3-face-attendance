/** Wall clock for the kiosk: DS3231 is the source, SNTP the corrector (KEHOACH 6.2.5).
 *  @ctx task | blocking on the i2c bus | takes m_i2c
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Where the current wall clock came from, worst to best. */
typedef enum {
    SYS_TIME_SOURCE_NONE = 0,  // no clock at all, ts is meaningless
    SYS_TIME_SOURCE_RTC,       // the RTC kept time but no NTP ever set it
    SYS_TIME_SOURCE_RTC_NTP,   // an ntp sync has set this rtc at some point
} sys_time_source_t;

/** Called from the SNTP task when a sync lands, so the caller can persist the marker.
 *  @ctx task | must not block long | called at most once per sync
 */
typedef void (*sys_time_synced_cb)(void *arg);

/** Read the RTC, set the system clock, and take the caller's persistent marker.
 *  @ctx task | blocking | takes m_i2c | call after bsp_board_init
 *  @param rtc_ntp_set the sys.rtc_ntp_set marker, read by the wiring layer
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND when the RTC does not answer
 */
esp_err_t sys_time_init(bool rtc_ntp_set);

/** How much the current wall clock can be trusted (KEHOACH 6.2.5 bit2).
 *  @ctx any | non-blocking
 */
sys_time_source_t sys_time_source(void);

/** Milliseconds since the epoch, 0 while the source is SYS_TIME_SOURCE_NONE.
 *  @ctx any | non-blocking
 */
int64_t sys_time_now_ms(void);

/** Start SNTP; each successful sync writes the corrected time back to the RTC.
 *  @ctx task | non-blocking | needs a live netif
 *  @param server host from device.sntp_host, read by the wiring layer (KEHOACH 4.9)
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE without init or on a second call
 */
esp_err_t sys_time_sync_start(const char *server, sys_time_synced_cb on_synced, void *arg);

/** Overwrite the RTC from the system clock and clear its oscillator-stopped flag.
 *  @ctx task | blocking | takes m_i2c
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE without init
 */
esp_err_t sys_time_write_rtc(void);

#ifdef __cplusplus
}
#endif
