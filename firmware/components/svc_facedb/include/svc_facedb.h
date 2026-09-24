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

/** Read one stored template back out, for reporting it to the server.
 *  @ctx task | blocking | takes m_facedb
 *  @param emb at least STORAGE_EMBED_DIM bytes; quality may be NULL
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND | ESP_ERR_INVALID_ARG | ESP_ERR_TIMEOUT
 */
esp_err_t svc_facedb_template(uint32_t employee_id, uint16_t template_idx, int8_t *emb,
                              size_t cap, float *scale, uint8_t *quality);

/** One enrolled person, however many templates they carry. */
typedef struct {
    uint32_t employee_id;
    uint16_t templates;
    char name[STORAGE_NAME_CAP];
} svc_facedb_person_t;

/** Fill out with the people in the table, one entry each.
 *  @ctx task | blocking | takes m_facedb
 *  @ret how many it wrote, never more than cap
 */
size_t svc_facedb_people(svc_facedb_person_t *out, size_t cap);

/** Soft-delete every template of one employee.
 *  @ctx task | blocking | takes m_facedb | in RAM only until svc_facedb_persist
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND when nothing carried that id | ESP_ERR_TIMEOUT
 */
esp_err_t svc_facedb_remove(uint32_t employee_id);

/** Soft-delete one template of one employee.
 *  @ctx task | blocking | takes m_facedb | in RAM only until svc_facedb_persist
 *  @ret ESP_OK | ESP_ERR_NOT_FOUND when that pair is not held | ESP_ERR_TIMEOUT
 */
esp_err_t svc_facedb_remove_template(uint32_t employee_id, uint16_t template_idx);

/** Soft-delete every template, for the clear half of a full resync.
 *  @ctx task | blocking | takes m_facedb | the kiosk matches nobody until
 *       the upserts that follow arrive (KEHOACH 7.5)
 *  @ret ESP_OK | ESP_ERR_TIMEOUT
 */
esp_err_t svc_facedb_clear(void);

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
