/** The face pipeline as one step per camera frame: detect every frame, then at
 *  most one more model, and an event when something worth reporting happened.
 *  @ctx ai_task only | blocking for the models it runs | no lock of its own (KEHOACH 4.5.5d)
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_camera.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define SVC_VISION_REPORTED_FACES 4

/** The four business thresholds, read from NVS by main (KEHOACH 4.9). */
typedef struct {
    float detect_min_score;               // a detection below this is not a face
    float live_min_score;                 // liveness below this is a presentation attack
    float match_min_score;                // cosine below this is a stranger
    int face_min_px;                      // a face narrower than this is not verified
} svc_vision_thresholds_t;

typedef enum {
    SVC_VISION_NONE = 0,                  // nothing new: tracking a face already reported on
    SVC_VISION_NO_FACE,                   // the frame lost every face
    SVC_VISION_FACE_SMALL,                // a face is there, too far for recognition
    SVC_VISION_SPOOF,                     // liveness below the floor
    SVC_VISION_UNKNOWN,                   // live, no template close enough
    SVC_VISION_MATCH,                     // live and matched
} svc_vision_kind_t;

typedef struct {
    float box[4];                         // x1, y1, x2, y2 in frame pixels
} svc_vision_box_t;

/** One event from one step. Scores are -1 where the stage did not run. */
typedef struct {
    svc_vision_kind_t kind;
    uint32_t employee_id;                 // valid for MATCH
    float match_score;
    float live_score;
    float wide_scale;                     // context the frame allowed the wide crop
    svc_vision_box_t primary;             // the face being tracked
    svc_vision_box_t boxes[SVC_VISION_REPORTED_FACES];
    uint8_t faces;                        // faces this detect saw, may exceed the boxes kept
} svc_vision_result_t;

/** Take the thresholds and check the recognition branch is there.
 *  @ctx task | non-blocking | call after ai_engine_init and svc_facedb_init
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE on a second call | ESP_ERR_NOT_FOUND | ESP_ERR_INVALID_ARG
 */
esp_err_t svc_vision_init(const svc_vision_thresholds_t *thresholds);

/** Feed one RGB565 frame; the caller keeps the frame and returns it afterwards.
 *  @ctx ai_task | blocking: detect, plus spoof and recog once the face is stable (KEHOACH 4.5.5d)
 *  @ret ESP_OK with out->kind set | ESP_ERR_INVALID_STATE | ESP_ERR_INVALID_ARG on another pixel format
 */
esp_err_t svc_vision_step(const camera_fb_t *frame, svc_vision_result_t *out);

/** Drop the tracked face and any verification in flight.
 *  @ctx ai_task | non-blocking
 */
void svc_vision_reset(void);

#ifdef __cplusplus
}
#endif
