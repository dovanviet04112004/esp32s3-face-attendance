/** The enrolled templates: int8 embeddings in PSRAM, cosine search, two-phase persistence.
 *  @ctx task | blocking | every call but count takes m_facedb (KEHOACH 5.3)
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "storage_format.h"

#ifdef __cplusplus
extern "C" {
#endif

#define SVC_FACEDB_EMBED_BYTES STORAGE_EMBED_DIM

/** The template closest to a query and how close it came. */
typedef struct {
    uint32_t employee_id;
    uint16_t template_idx;
    float score;                          // cosine, -1..1
    char name[STORAGE_NAME_CAP];          // empty when the record carries none
} svc_facedb_match_t;

/** Reserve the table in PSRAM and load db/faces.bin, or start empty when there is none.
 *  @ctx task | blocking | call after sys_storage_init
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE on a second call | ESP_ERR_NO_MEM
 *       | ESP_ERR_INVALID_VERSION when the file is another format | ESP_ERR_INVALID_SIZE
 */
esp_err_t svc_facedb_init(void);

/** The template closest to an embedding; the caller applies the match threshold.
 *  @ctx task | blocking, scans the whole table | takes m_facedb
 *  @param scale the query's dequant factor, unused: cosine cancels a positive factor
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND with no active template | ESP_ERR_TIMEOUT
 */
esp_err_t svc_facedb_lookup(const int8_t *emb, float scale, svc_facedb_match_t *out);

/** Add a template, replacing the one with the same employee and index if it exists.
 *  @ctx task | blocking | takes m_facedb | in RAM only until svc_facedb_persist
 *  @ret ESP_OK | ESP_ERR_NO_MEM when the table is full even after compaction | ESP_ERR_TIMEOUT
 */
esp_err_t svc_facedb_enroll(uint32_t employee_id, uint16_t template_idx, uint8_t quality,
                            const int8_t *emb, float scale, const char *name);

/** Soft-delete every template of one employee.
 *  @ctx task | blocking | takes m_facedb | in RAM only until svc_facedb_persist
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND when nothing carried that id | ESP_ERR_TIMEOUT
 */
esp_err_t svc_facedb_remove(uint32_t employee_id);

/** Write the table to flash in two phases, compacting once over 30 percent of it is dead.
 *  @ctx task | blocking, seconds for a full table | takes m_facedb, then m_littlefs inside
 *  @ret ESP_OK | ESP_FAIL when the rename chain did not complete | ESP_ERR_TIMEOUT
 */
esp_err_t svc_facedb_persist(void);

/** How many templates are active, zero until init.
 *  @ctx any | non-blocking
 */
size_t svc_facedb_count(void);

#ifdef __cplusplus
}
#endif
