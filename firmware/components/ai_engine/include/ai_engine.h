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

/** A camera frame as drv_camera hands it out: RGB565 words, row-major. */
typedef struct {
    const uint16_t *pixels;
    int width;
    int height;
} ai_engine_frame_t;

/** How the last ai_engine_detect_frame fitted the frame into the detector. */
typedef struct {
    float scale;                          // frame pixels times this land in the detector
    int pad_x;                            // black columns on the left
    int pad_y;                            // black rows on the top
} ai_engine_letterbox_t;

/** Run the detector over one letterboxed frame.
 *  @ctx ai_task | blocking for the whole graph
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE | ESP_ERR_INVALID_SIZE | ESP_FAIL
 */
esp_err_t ai_engine_detect(const int8_t *image);

/** Letterbox a camera frame into the detector and run it (KEHOACH 3, letterbox_params).
 *  @ctx ai_task | blocking for the resample and the whole graph
 *  @param geometry receives what ai_engine_face_to_frame needs; may be NULL
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE | ESP_ERR_INVALID_ARG | ESP_FAIL
 */
esp_err_t ai_engine_detect_frame(const ai_engine_frame_t *frame, ai_engine_letterbox_t *geometry);

/** One face of the last detector run, in the detector's own input pixels. */
typedef struct {
    float box[4];                         // x1, y1, x2, y2
    float landmarks[10];                  // x, y pairs: eyes, nose, mouth corners
    float score;                          // 0..1
} ai_engine_face_t;

/** Faces of the last ai_engine_detect at or above min_score, best first, after NMS.
 *  @ctx ai_task | non-blocking | reads the output tensors, so call ahead of the next detect
 *  @param min_score the confidence floor the caller owns (KEHOACH 4.9)
 *  @ret faces written, at most cap; zero until a detect has run
 */
size_t ai_engine_faces(float min_score, ai_engine_face_t *out, size_t cap);

/** Move one face from detector input pixels to the frame it came from.
 *  @ctx any | non-blocking
 */
void ai_engine_face_to_frame(const ai_engine_letterbox_t *geometry, ai_engine_face_t *face);

/** Align a face by its five landmarks in frame pixels and embed it.
 *  @ctx ai_task | blocking for the warp and the whole graph
 *  @param out unit-length embedding as symmetric int8, cap_bytes at least ai_engine_recog_output_bytes
 *  @param scale receives the dequant factor of that int8 vector
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE | ESP_ERR_INVALID_ARG | ESP_FAIL
 */
esp_err_t ai_engine_recognize_face(const ai_engine_frame_t *frame, const float landmarks[10], int8_t *out,
                                   size_t cap_bytes, float *scale);

/** Cut the tight and wide crops of a face box in frame pixels and score its liveness.
 *  @ctx ai_task | blocking for the crops and the whole graph
 *  @param wide_scale receives the context ratio the frame allowed, at most 2.7; may be NULL
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE | ESP_ERR_INVALID_ARG | ESP_FAIL
 */
esp_err_t ai_engine_spoof_face(const ai_engine_frame_t *frame, const float box[4], float *live, float *wide_scale);

/** Align a face into a caller buffer with the recogniser's input shape and
 *  quantisation, without running it; feed it later through ai_engine_recognize.
 *  @ctx ai_task | blocking for the warp
 *  @param cap_bytes at least ai_engine_recog_input_bytes
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE | ESP_ERR_INVALID_ARG | ESP_ERR_INVALID_SIZE
 */
esp_err_t ai_engine_align_face(const ai_engine_frame_t *frame, const float landmarks[10], int8_t *out,
                               size_t cap_bytes);

/** Cut the tight and wide crops into caller buffers shaped for the spoof graph,
 *  without running it; feed them later through ai_engine_spoof.
 *  @ctx ai_task | blocking for the two resamples
 *  @param cap_bytes size of each buffer, at least ai_engine_spoof_input_bytes
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE | ESP_ERR_INVALID_ARG | ESP_ERR_INVALID_SIZE
 */
esp_err_t ai_engine_spoof_crops(const ai_engine_frame_t *frame, const float box[4], int8_t *tight, int8_t *wide,
                                size_t cap_bytes, float *wide_scale);

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
