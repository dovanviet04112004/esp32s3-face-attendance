/** The one C entry point to the models this device runs.
 *  @ctx ai_task only | blocking | everything below needs sys_storage up first
 *  Every call writes the interpreters' own input tensors, and KEHOACH 5.2
 *  gives them one caller, so nothing here takes a lock.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** What one arena reserved and how much of it the models on it hold. */
typedef struct {
    size_t fast_bytes;                    // reserved for detect and spoof
    size_t fast_used;                     // handed out by its allocator
    size_t big_bytes;                     // reserved for recognition
    size_t big_used;
    bool fast_internal;                   // false once it fell back to psram
} ai_engine_arena_stats_t;

/** Map the models partition and reserve both arenas.
 *  @ctx task | blocking | call once from app_main after sys_storage_init
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE | ESP_ERR_NO_MEM | ESP_ERR_NOT_FOUND
 */
esp_err_t ai_engine_init(void);

/** Where the two arenas of KEHOACH 3.10 ended up, all zero until init.
 *  @ctx any | non-blocking
 */
void ai_engine_arena_stats(ai_engine_arena_stats_t *out);

/** How many int8 samples one branch's input holds, read from its own graph.
 *  @ctx any | non-blocking | zero until init
 */
size_t ai_engine_detect_input_len(void);
size_t ai_engine_spoof_input_len(void);
size_t ai_engine_recog_input_len(void);

/** Run the detector over one letterboxed frame.
 *  @ctx ai_task | blocking for the whole graph
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE | ESP_ERR_INVALID_SIZE | ESP_FAIL
 */
esp_err_t ai_engine_detect(const int8_t *image);

/** Score one face as live or presented, from two crops already in the graph's
 *  own quantisation.
 *  @ctx ai_task | blocking for the whole graph
 *  @param tight the face box, @param wide the same face with context around it
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE | ESP_ERR_INVALID_SIZE | ESP_FAIL
 */
esp_err_t ai_engine_spoof(const int8_t *tight, const int8_t *wide, float *live);

/** Embed one aligned face.
 *  @ctx ai_task | blocking for the whole graph
 *  @param scale receives the dequant factor the int8 embedding carries
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE | ESP_ERR_INVALID_SIZE | ESP_FAIL
 */
esp_err_t ai_engine_recognize(const int8_t *face, int8_t *out, size_t cap, float *scale);

#ifdef __cplusplus
}
#endif
