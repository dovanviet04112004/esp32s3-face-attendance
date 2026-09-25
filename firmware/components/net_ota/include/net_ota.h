/** Fetch a signed image over HTTPS and hand it to the slot that is not running.
 *  @ctx ota_task | blocking for the whole download | one call at a time
 */
#pragma once

#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** One image on offer, already lifted out of the MQTT manifest by the caller. */
typedef struct {
    const char *url;                      // https only, refused otherwise
    const char *sha256;                    // 64 lowercase hex, of the whole image
    size_t size_bytes;                     // refused when the body does not match
} net_ota_image_t;

#define NET_OTA_WHY_CAP 64

/** Whether this manifest is worth opening a connection for.
 *  @ctx any | non-blocking | the same checks net_ota_firmware runs first, so a
 *       caller that has to spend something to download can spend nothing here
 *  @ret ESP_OK | ESP_ERR_INVALID_ARG | ESP_ERR_INVALID_SIZE
 */
esp_err_t net_ota_check(const net_ota_image_t *image, bool models, char *why,
                        size_t cap);

/** Download into the inactive app partition and arm it for the next boot.
 *  @ctx ota_task | blocking, tens of seconds | why takes NET_OTA_WHY_CAP bytes
 *  @ret ESP_OK and the caller reboots | ESP_ERR_INVALID_ARG on a refused manifest
 *       | ESP_ERR_INVALID_CRC when the digest disagrees | ESP_FAIL on transport
 */
esp_err_t net_ota_firmware(const net_ota_image_t *image, char *why, size_t cap);

/** Download into the models slot this boot is not reading and arm it.
 *  @ctx ota_task | blocking, erasing 3 MB then pulling the image | why takes
 *       NET_OTA_WHY_CAP bytes
 *  @ret ESP_OK and the caller reboots | ESP_ERR_INVALID_ARG on a refused
 *       manifest | ESP_ERR_INVALID_CRC on a bad digest or header
 */
esp_err_t net_ota_models(const net_ota_image_t *image, char *why, size_t cap);

/** Tell the bootloader this build works, so it stops holding a rollback.
 *  @ctx task | non-blocking | a settled build takes no harm from it
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE when no OTA slot is running
 */
esp_err_t net_ota_mark_valid(void);

/** How much of the image being downloaded has arrived, as a percentage.
 *  @ctx any | non-blocking | 0 until a download starts, 100 once one ends
 */
uint8_t net_ota_percent(void);

/** Whether this boot is a fresh image the bootloader will undo unless marked.
 *  @ctx any | non-blocking
 */
bool net_ota_on_trial(void);

/** Where a download stands, for whoever shows it (KEHOACH 7.7). */
typedef enum {
    NET_OTA_PHASE_IDLE = 0,
    NET_OTA_PHASE_CONNECTING,             // dialling and erasing, no byte yet
    NET_OTA_PHASE_FETCHING,
    NET_OTA_PHASE_CHECKING,               // all in; digest, image checks, arming
} net_ota_phase_t;

/** Why the last download stopped, in the kinds a screen can put into words. */
typedef enum {
    NET_OTA_FAULT_OTHER = 0,
    NET_OTA_FAULT_NETWORK,
    NET_OTA_FAULT_DIGEST,
    NET_OTA_FAULT_REFUSED,
    NET_OTA_FAULT_TOO_BIG,
} net_ota_fault_t;

/** @ctx any | non-blocking */
net_ota_phase_t net_ota_phase(void);

/** @ctx any | non-blocking | meaningful once a download or check has failed */
net_ota_fault_t net_ota_fault(void);

#ifdef __cplusplus
}
#endif
