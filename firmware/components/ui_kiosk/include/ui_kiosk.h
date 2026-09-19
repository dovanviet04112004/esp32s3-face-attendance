/** The kiosk's screens: drawn as a cover map cam_task lays over its preview.
 *  @ctx task | non-blocking | ui_task owns the screens, cam_task only reads
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "app_events.h"
#include "drv_lcd.h"
#include "esp_err.h"
#include "storage_format.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Reserve the cover map and open on the scan screen.
 *  @ctx task | blocking | call once from app_boot, after drv_lcd_init
 *  @ret ESP_OK | ESP_ERR_NO_MEM | ESP_ERR_INVALID_STATE if already up
 */
esp_err_t ui_kiosk_init(void);

/** Why the pipeline is not verifying the face it can see, or that it is.
 *  The screen may advise on framing, but only this says work is happening,
 *  and only svc_vision knows that (KEHOACH 4.5.5h.1).
 */
typedef enum {
    UI_KIOSK_STAGE_WORKING = 0,           // the face passed every gate
    UI_KIOSK_STAGE_NO_FACE,
    UI_KIOSK_STAGE_TOO_FAR,               // under vision.face_min_px
    UI_KIOSK_STAGE_TOO_CLOSE,             // the 1.0x crop would leave the frame
} ui_kiosk_stage_t;

/** Tell the screens what the detector saw, in sensor frame pixels.
 *  @ctx ai_task | non-blocking | boxes holds count sets of four
 *  @param yaw of the tracked face, 0 facing the lens (KEHOACH 4.5.5h.2)
 */
void ui_kiosk_on_faces(const float *boxes, int count, int frame_width, int frame_height,
                       float yaw, uint32_t track);

/** Tell the screens what the pipeline decided about that face.
 *  @ctx ai_task | non-blocking | one per step, after svc_vision_step
 */
void ui_kiosk_on_stage(ui_kiosk_stage_t stage);

/** Say what the kiosk decided about that face.
 *  @ctx attend_task | non-blocking | employee_id and name read empty unless granted
 */
void ui_kiosk_on_verdict(app_ui_verdict_t verdict, uint32_t employee_id, const char *name);

/** Hand one touch to the screen showing.
 *  @ctx touch_task | non-blocking | down = false when the finger lifts
 */
void ui_kiosk_on_touch(bool down, int x, int y);

/** Run the screen showing and repaint it when it has something new to say.
 *  @ctx ui_task | non-blocking | dt_ms is the time since the last call
 */
void ui_kiosk_tick(uint32_t dt_ms);

/** Collect a face the enrol screen is waiting for.
 *  @ctx ui_task | non-blocking | one shot: the request clears as it is taken
 *  @param employee_id 0 for a person with no id yet, which the caller assigns
 *  @param yaw the turn window the sample asks for (KEHOACH 4.5.5h.2)
 *  @ret false when no screen is asking for one
 */
bool ui_kiosk_take_enrol(uint32_t *employee_id, uint16_t *template_idx, char *name, size_t cap,
                         float *yaw_min, float *yaw_max);

/** Tell the enrol flow the pipeline has kept the face it asked for.
 *  @ctx ui_task | non-blocking
 */
void ui_kiosk_enrol_kept(void);

/** Tell the enrol flow the pipeline turned the offered face away as a spoof.
 *  @ctx ai_task | non-blocking | every refusal, the screen does the counting
 */
void ui_kiosk_enrol_refused(void);

#define UI_KIOSK_SETTINGS_LINES 8

/** Hand the settings page its lines, main's view of the kiosk (KEHOACH 4.5.5h.4).
 *  @ctx ui_task | non-blocking | copied, at most UI_KIOSK_SETTINGS_LINES
 */
void ui_kiosk_set_settings(const char *const *lines, int count);

/** One row of the people list, filled by main from the table it can reach. */
typedef struct {
    uint32_t employee_id;
    uint16_t templates;
    char name[STORAGE_NAME_CAP];
} ui_kiosk_person_t;

#define UI_KIOSK_PEOPLE_ROWS 8

/** True when a screen has opened that needs the list refreshed.
 *  @ctx ui_task | non-blocking | one shot: the request clears as it is taken
 */
bool ui_kiosk_take_people_request(void);

/** Collect the employee the people screen asked to delete.
 *  @ctx ui_task | non-blocking | one shot: the request clears as it is taken
 *  @ret false when nobody is waiting to be removed
 */
bool ui_kiosk_take_remove(uint32_t *employee_id);

/** Hand the list to whichever screen asked for it.
 *  @ctx ui_task | non-blocking | copied, the caller keeps its own array
 */
void ui_kiosk_set_people(const ui_kiosk_person_t *people, int count);

/** True while a screen is collecting faces rather than checking anyone in.
 *  @ctx ai_task | non-blocking
 */
bool ui_kiosk_enrolling(void);

/** Whether the last enrolment took all of its samples (KEHOACH 4.5.5h.2).
 *  @ctx any | non-blocking | read after ui_kiosk_enrolling goes false
 */
bool ui_kiosk_enrol_complete(void);

/** The cover map to paint over this frame.
 *  @ctx cam_task | non-blocking | read once per frame
 *  @ret NULL until the first screen has been painted
 */
const drv_lcd_overlay_t *ui_kiosk_overlay(void);

/** Take the overlay on the glass and claim its slot against repainting.
 *  @ctx task | non-blocking | one caller only, and each hold needs its release
 *  @ret the same pointer ui_kiosk_overlay gives, NULL until the first publish
 */
const drv_lcd_overlay_t *ui_kiosk_hold(void);

/** Whether the screen on the glass hides the camera behind it.
 *  @ctx any | non-blocking | answers without touching an overlay slot
 */
bool ui_kiosk_screen_covers(void);

/** Give back the slot claimed by ui_kiosk_hold.
 *  @ctx task | non-blocking | safe to call without a matching hold
 */
void ui_kiosk_release(void);

#ifdef __cplusplus
}
#endif
