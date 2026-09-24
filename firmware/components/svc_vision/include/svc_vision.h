/** The face pipeline as one step per camera frame: detect every frame, then at
 *  most one more model, and an event when something worth reporting happened.
 *  @ctx ai_task only | blocking for the models it runs | no lock of its own (KEHOACH 4.5.5d)
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_camera.h"
#include "esp_err.h"
#include "storage_format.h"

#ifdef __cplusplus
extern "C" {
#endif

#define SVC_VISION_REPORTED_FACES 4

/** The business thresholds from NVS (KEHOACH 4.9) and the guide drawn on the glass. */
typedef struct {
    float detect_min_score;               // a detection below this is not a face
    float live_min_score;                 // liveness below this is a presentation attack
    float match_min_score;                // cosine below this is a stranger
    int face_min_px;                      // a face narrower than this is not verified
    float guide[4];                       // x1, y1, x2, y2 of the guide, frame pixels
    float guide_min_share;                // part of a face box that must lie in guide
} svc_vision_thresholds_t;

typedef enum {
    SVC_VISION_NONE = 0,                  // nothing new: tracking a face already reported on
    SVC_VISION_NO_FACE,                   // the frame lost every face
    SVC_VISION_FACE_SMALL,                // a face is there, too far for recognition
    SVC_VISION_FACE_OUT_OF_FRAME,         // the 1.0x crop would run off the frame
    SVC_VISION_FACE_OK,                   // through the gates, a model runs this step
    SVC_VISION_SPOOF,                     // liveness below the floor
    SVC_VISION_UNKNOWN,                   // live, no template close enough
    SVC_VISION_MATCH,                     // live and matched
    SVC_VISION_FACE_SETTLED,              // in frame, and the kiosk is done with it
    SVC_VISION_FACE_OFF_GUIDE,            // under guide_min_share of the face in guide
} svc_vision_kind_t;

typedef struct {
    float box[4];                         // x1, y1, x2, y2 in frame pixels
    float yaw;                            // nose along the eye axis, 0 facing the lens
} svc_vision_box_t;

/** One event from one step. Scores are -1 where the stage did not run. */
typedef struct {
    svc_vision_kind_t kind;
    uint32_t track;                       // the track the observer heard this step
    uint32_t employee_id;                 // valid for MATCH
    char name[STORAGE_NAME_CAP];          // valid for MATCH, empty when unnamed
    float match_score;
    float live_score;
    svc_vision_box_t primary;             // the face being tracked
    svc_vision_box_t boxes[SVC_VISION_REPORTED_FACES];
    uint8_t faces;                        // faces this detect saw, may exceed the boxes kept
} svc_vision_result_t;

/** Take the thresholds and check the recognition branch is there.
 *  @ctx task | non-blocking | call after ai_engine_init and svc_facedb_init
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE on a second call | ESP_ERR_NOT_FOUND | ESP_ERR_INVALID_ARG
 */
esp_err_t svc_vision_init(const svc_vision_thresholds_t *thresholds);

/** Called inside a step the moment detect has run, ahead of the slow models.
 *  @ctx ai_task | must not block: the pipeline is holding the frame
 */
typedef void (*svc_vision_seen_cb_t)(const svc_vision_box_t *boxes, uint8_t count, uint32_t track,
                                     svc_vision_kind_t stage, void *ctx);

/** Hear where the faces are as soon as the detector knows, not when the step ends.
 *  @ctx task | non-blocking | one observer, NULL to drop it (KEHOACH 4.5.5d)
 */
void svc_vision_on_seen(svc_vision_seen_cb_t cb, void *ctx);

/** Keep the next face this pipeline embeds, under this id and name.
 *  @ctx task | non-blocking | one shot: the next embedding is kept, then matched
 *  @param yaw_min the turn window the sample must fall in (KEHOACH 4.5.5h.2)
 *  @ret ESP_OK | ESP_ERR_INVALID_STATE until svc_vision_init has run
 */
esp_err_t svc_vision_enrol_next(uint32_t employee_id, uint16_t template_idx, const char *name,
                                float yaw_min, float yaw_max);

/** True while a face asked for by svc_vision_enrol_next has not arrived yet.
 *  @ctx any | non-blocking | clears the moment the pipeline keeps one
 */
bool svc_vision_enrol_pending(void);

/** The smallest face this pipeline will verify, in frame pixels.
 *  @ctx any | non-blocking | zero until svc_vision_init has run
 */
int svc_vision_face_min_px(void);

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
