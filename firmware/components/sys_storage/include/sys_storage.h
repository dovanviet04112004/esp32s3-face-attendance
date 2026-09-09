/** The only component allowed to touch NVS, LittleFS and the flash partitions.
 *  @ctx task | blocking | every path below is under the LittleFS mount
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

/** Open NVS, mount LittleFS, and empty the scratch directory.
 *  @ctx task | blocking | call once from app_main
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE if already up | ESP_ERR_NOT_FOUND
 */
esp_err_t sys_storage_init(void);

/** Read one unsigned setting.
 *  @ctx task | blocking | takes m_littlefs (KEHOACH 5.3)
 *  @ret ESP_OK | ESP_ERR_NVS_NOT_FOUND, leaving the destination untouched
 */
esp_err_t sys_storage_get_u32(const char *key, uint32_t *value);

/** Write one unsigned setting and commit it.
 *  @ctx task | blocking | takes m_littlefs
 */
esp_err_t sys_storage_set_u32(const char *key, uint32_t value);

/** How many times this device has booted, counted up once per init.
 *  @ctx any | non-blocking | the high half of every attendance local_id
 */
uint32_t sys_storage_boot_count(void);

/** Replace a file so a power cut leaves either the old bytes or the new ones.
 *  @ctx task | blocking | takes m_littlefs | writes through a temporary
 *  @ret ESP_OK | ESP_FAIL when the rename chain did not complete
 */
esp_err_t sys_storage_write_atomic(const char *path, const void *data, size_t len);

/** Read a whole file into a caller's buffer.
 *  @ctx task | blocking | takes m_littlefs
 *  @param out_len receives the byte count, which may be shorter than cap
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND | ESP_ERR_INVALID_SIZE when cap is too small
 */
esp_err_t sys_storage_read(const char *path, void *buf, size_t cap, size_t *out_len);

/** Read a record file, falling back to its backup when the header is damaged.
 *  @ctx task | blocking | takes m_littlefs (KEHOACH 6.2.6)
 *  @param magic the file magic the header must carry
 *  @param used_backup set true when the primary copy failed its check
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND when neither copy is readable
 */
esp_err_t sys_storage_read_checked(const char *path, uint32_t magic, void *buf, size_t cap,
                                   size_t *out_len, bool *used_backup);

/** The checksum every header and record on flash carries.
 *  @ctx any | non-blocking | callers fill their own header with this
 */
uint32_t sys_storage_crc32(const void *data, size_t len);

/** Append one record and push it to flash immediately.
 *  @ctx task | blocking ~10-20 ms | takes m_littlefs (KEHOACH 6.2.6)
 */
esp_err_t sys_storage_append(const char *path, const void *record, size_t len);

/** Map the models partition and hand back its header.
 *  @ctx task | blocking | the mapping lives until reboot
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND when the partition holds no image
 *       | ESP_ERR_INVALID_CRC on a damaged header or an unknown format_ver
 */
esp_err_t sys_storage_models_open(const storage_models_header_t **header);

/** Find one model inside the mapped partition by its packed name.
 *  @ctx any | non-blocking | valid only after sys_storage_models_open
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND when no entry carries that name
 *       | ESP_ERR_INVALID_SIZE when the entry does not lie inside the image
 */
esp_err_t sys_storage_model_find(const char *name, const void **data, size_t *size);

#ifdef __cplusplus
}
#endif
