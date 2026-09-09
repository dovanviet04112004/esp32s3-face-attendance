/** The one C entry point to the models this device runs.
 *  @ctx ai_task only | blocking | everything below needs sys_storage up first
 *  Every call writes the interpreters' own input tensors, and KEHOACH 5.2
 *  gives them one caller, so nothing here takes a lock.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** What each arena reserved and how much of it the models on it hold. */
typedef struct {
    size_t fast_bytes;                    // reserved for detect alone
    size_t fast_used_bytes;               // handed out by its allocator
    size_t big_bytes;                     // reserved for spoof and recog together
    size_t big_used_bytes;                // handed out by its allocator
    bool fast_internal;                   // true only while it sits in internal sram
} ai_engine_arena_stats_t;

/** Map the models partition and reserve both arenas.
 *  @ctx task | blocking | call once from app_main, ahead of every driver
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE | ESP_ERR_NO_MEM | ESP_ERR_NOT_FOUND
 *       | ESP_ERR_NOT_SUPPORTED when a graph needs an operator this build omits
 *       | ESP_ERR_INVALID_CRC | ESP_ERR_INVALID_SIZE
 */
esp_err_t ai_engine_init(void);

/** Where the two arenas of KEHOACH 3.8 ended up, all zero until init.
 *  @ctx any | non-blocking
 */
void ai_engine_arena_stats(ai_engine_arena_stats_t *out);

/** How many bytes one branch's input tensor holds, read from its own graph.
 *  @ctx any | non-blocking | zero until init, and zero for an absent branch
 */
size_t ai_engine_detect_input_bytes(void);
size_t ai_engine_spoof_input_bytes(void);
size_t ai_engine_recog_input_bytes(void);

/** How many bytes ai_engine_recognize writes, so a caller can size its buffer.
 *  @ctx any | non-blocking | zero until init
 */
size_t ai_engine_recog_output_bytes(void);

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
 *  @param cap_bytes at least ai_engine_recog_output_bytes, all of which is written
 *  @param scale receives the dequant factor the int8 embedding carries
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE | ESP_ERR_INVALID_SIZE | ESP_FAIL
 */
esp_err_t ai_engine_recognize(const int8_t *face, int8_t *out, size_t cap_bytes, float *scale);

#ifdef __cplusplus
}
#endif
