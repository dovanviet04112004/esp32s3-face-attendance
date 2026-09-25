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
    UI_KIOSK_STAGE_SETTLED,               // a face is there and the kiosk has finished
    UI_KIOSK_STAGE_OFF_GUIDE,             // under vision.guide_min of it in the guide
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

/** One thing the kiosk decided about one face, as the scan screen tells it. */
typedef struct {
    app_ui_verdict_t verdict;
    uint32_t track;                       // the svc_vision track it is about, 0 for none
    uint32_t employee_id;                 // GRANTED only
    char name[STORAGE_NAME_CAP];          // GRANTED only, empty when unnamed
} ui_kiosk_verdict_t;

/** Say what the kiosk decided about a face, or SCANNING when it takes up someone new.
 *  @ctx attend_task | non-blocking | copied under a spinlock (KEHOACH 5.3)
 */
void ui_kiosk_on_verdict(const ui_kiosk_verdict_t *verdict);

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

#define UI_KIOSK_FACTS 8

/** Which reading a device page row carries (KEHOACH 4.5.5h.4). */
typedef enum {
    UI_KIOSK_FACT_VERSION = 0,
    UI_KIOSK_FACT_DEVICE_ID,
    UI_KIOSK_FACT_ENROLLED,
    UI_KIOSK_FACT_RECORDS,
    UI_KIOSK_FACT_WIFI_DROPS,
    UI_KIOSK_FACT_WAKE_WITHIN,
    UI_KIOSK_FACT_MIN_FACE,
    UI_KIOSK_FACT_RAM_FREE,
} ui_kiosk_fact_kind_t;

/** One reading on the device page; wording the label is the kiosk's job.
 *  Units that read the same in both languages stay in value (CLAUDE.md 3.1).
 */
typedef struct {
    ui_kiosk_fact_kind_t kind;
    char value[32];
} ui_kiosk_fact_t;

/** Hand the device page what main knows without reading flash.
 *  @ctx ui_task | non-blocking | copied, at most UI_KIOSK_FACTS
 */
void ui_kiosk_set_facts(const ui_kiosk_fact_t *facts, int count);

/** What the settings page says on its Wi-Fi row. */
typedef struct {
    bool joined;
    char ssid[33];
    int rssi_dbm;
} ui_kiosk_net_t;

/** Tell the screens where the radio stands.
 *  @ctx any | non-blocking
 */
void ui_kiosk_set_net(const ui_kiosk_net_t *net);

/** Where this kiosk stands with the server's approval (KEHOACH 7.3). */
typedef enum {
    UI_KIOSK_TICKET_HELD = 0,             // it can log in; nothing is shown
    UI_KIOSK_TICKET_WAITING,              // registered, nobody has approved it yet
    UI_KIOSK_TICKET_REFUSED,              // the server rejects this batch token
    UI_KIOSK_TICKET_NO_TOKEN,             // this build carries no batch token
    UI_KIOSK_TICKET_OFFLINE,              // no ticket, and the server is out of reach
} ui_kiosk_ticket_t;

/** Show or clear the lines between the top bar and the guide (KEHOACH 4.5.5h.1).
 *  @ctx any | non-blocking | device_id and claim copied; NULL keeps the one held
 *  @param claim the six digits an admin types to approve, shown while WAITING
 */
void ui_kiosk_set_ticket(ui_kiosk_ticket_t state, const char *device_id, const char *claim);

/** Where an update the server offered stands on this kiosk (KEHOACH 7.7). */
typedef enum {
    UI_KIOSK_UPDATE_NONE = 0,             // nothing is shown
    UI_KIOSK_UPDATE_CONNECTING,           // offer taken, no byte yet
    UI_KIOSK_UPDATE_FETCHING,             // bytes arriving
    UI_KIOSK_UPDATE_CHECKING,             // all in, digest and image checks
    UI_KIOSK_UPDATE_RESTARTING,           // armed, about to reboot into it
    UI_KIOSK_UPDATE_FAILED,               // shown for a while, then punching resumes
    UI_KIOSK_UPDATE_DONE,                 // the new build is up; the scan screen says so
} ui_kiosk_update_t;

/** Why an update did not go through, as the failure screen words it. */
typedef enum {
    UI_KIOSK_UPDATE_WHY_OTHER = 0,
    UI_KIOSK_UPDATE_WHY_NETWORK,          // the link dropped mid-image
    UI_KIOSK_UPDATE_WHY_DIGEST,           // the bytes are not the image offered
    UI_KIOSK_UPDATE_WHY_REFUSED,          // the server would not hand the image out
    UI_KIOSK_UPDATE_WHY_TOO_BIG,          // larger than the slot
} ui_kiosk_update_why_t;

/** Show how an update stands; every state but NONE and DONE covers the panel (KEHOACH 7.7).
 *  @ctx any | non-blocking | version copied, NULL keeps the one held
 *  @param percent how much has arrived, read while FETCHING
 */
void ui_kiosk_set_update(ui_kiosk_update_t state, uint8_t percent, const char *version,
                         ui_kiosk_update_why_t why);

/** Move a download on; ignored once the update has failed or is restarting (KEHOACH 7.7).
 *  @ctx any | non-blocking
 *  @param phase CONNECTING, FETCHING or CHECKING
 */
void ui_kiosk_update_progress(ui_kiosk_update_t phase, uint8_t percent);

/** Whether the Update screen holds the panel: it wakes it, and punching waits (KEHOACH 5.4).
 *  @ctx any | non-blocking
 */
bool ui_kiosk_update_covers(void);

/** Seed what the two settings sliders rest at, from main's copy of NVS.
 *  @ctx ui_task | non-blocking
 */
void ui_kiosk_set_levels(uint8_t brightness, uint8_t volume);

/** Seed the language from NVS ui/lang; an absent or unknown code is Vietnamese.
 *  @ctx task | non-blocking | KEHOACH 6.2.1
 */
void ui_kiosk_set_language(const char *code);

/** Take the language the operator picked, so main can store it.
 *  @ctx ui_task | non-blocking | one shot, and code points at static storage
 *  @ret false when nobody picked one
 */
bool ui_kiosk_take_language(const char **code);

/** Which level a slider is reporting. */
typedef enum {
    UI_KIOSK_LEVEL_BRIGHTNESS = 0,
    UI_KIOSK_LEVEL_VOLUME,
} ui_kiosk_level_t;

/** Take a level the operator is turning, if one moved since the last call.
 *  @ctx ui_task | non-blocking | settled goes true on the touch that ends a drag,
 *       and only then may the caller write NVS (KEHOACH 4.5.5h.4)
 *  @ret false when nothing moved
 */
bool ui_kiosk_take_level(ui_kiosk_level_t *which, uint8_t *percent, bool *settled);

/** One employee waiting to be captured here: new, or held and up for a retake. */
typedef struct {
    uint32_t employee_id;
    char name[STORAGE_NAME_CAP];
    bool retake;                          // this kiosk already holds their face
} ui_kiosk_pending_t;

#define UI_KIOSK_PENDING_ROWS 8

/** Hand the enrol screen one page of the people waiting for a face (KEHOACH 7.5).
 *  @ctx any | non-blocking | copied, at most UI_KIOSK_PENDING_ROWS
 *  @param first where the page starts in the whole list; total is its length
 */
void ui_kiosk_set_pending(const ui_kiosk_pending_t *rows, int count, int first, int total);

/** The row the enrol screen's page starts at, which main fills from.
 *  @ctx any | non-blocking
 */
int ui_kiosk_pending_first(void);

/** True when the enrol screen has opened and wants that list refreshed.
 *  @ctx ui_task | non-blocking | one shot: the request clears as it is taken
 */
bool ui_kiosk_take_pending_request(void);

/** One row of the people list, filled by main from the table it can reach. */
typedef struct {
    uint32_t employee_id;
    uint16_t templates;
    char name[STORAGE_NAME_CAP];
} ui_kiosk_person_t;

#define UI_KIOSK_PEOPLE_ROWS 8

/** One network the radio heard, as the settings screen shows it. */
typedef struct {
    char ssid[33];
    int rssi_dbm;
    bool open;
    bool saved;                           // credentials for it are already in NVS
} ui_kiosk_ap_t;

#define UI_KIOSK_WIFI_ROWS 8
#define UI_KIOSK_WIFI_PASS_CAP 65

/** True when a screen has opened that needs the list refreshed.
 *  @ctx ui_task | non-blocking | one shot: the request clears as it is taken
 */
bool ui_kiosk_take_people_request(void);

/** Ask for the people list again, for a table another task has just edited.
 *  @ctx any | non-blocking | answered through ui_kiosk_take_people_request
 */
void ui_kiosk_refresh_people(void);

/** Whether the wifi screen is asking for a fresh sweep of the channels.
 *  @ctx any | non-blocking | scanning blocks, so never answer it on ui_task
 */
bool ui_kiosk_take_wifi_scan(void);

/** Hand the screen what the sweep heard.
 *  @ctx any | non-blocking
 */
void ui_kiosk_set_networks(const ui_kiosk_ap_t *found, int count);

/** Take the network the operator chose, if they chose one.
 *  @ctx any | non-blocking | true once per choice
 *  @param stored true when the screen asked for no passphrase because the one
 *         in NVS already belongs to this network, so pass comes back empty
 */
bool ui_kiosk_take_wifi_join(char *ssid, size_t ssid_cap, char *pass, size_t pass_cap,
                             bool *stored);

/** Tell the screen how the join went.
 *  @ctx any | non-blocking
 */
void ui_kiosk_wifi_joined(esp_err_t result);

/** Collect the employee the people screen asked to delete.
 *  @ctx ui_task | non-blocking | one shot: the request clears as it is taken
 *  @ret false when nobody is waiting to be removed
 */
bool ui_kiosk_take_remove(uint32_t *employee_id);

/** Collect the employee the people screen asked to capture again (KEHOACH 7.5).
 *  @ctx ui_task | non-blocking | one shot | name copied, at least STORAGE_NAME_CAP
 *  @ret false when nobody is waiting for a retake
 */
bool ui_kiosk_take_retake(uint32_t *employee_id, char *name, size_t cap);

/** Say whether device/enroll_out has room, so a full one refuses rather than drops.
 *  @ctx any | non-blocking
 */
void ui_kiosk_set_asks_room(bool room);

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

/** Why the scan screen wants the pipeline started over, if it does.
 *  @ctx ui_task | non-blocking | one shot: the request clears as it is taken
 *  @param stuck set when a face outlived every verdict it is owed, which is a
 *         fault worth a log line; clear when the operator simply came back
 *  @ret false when nothing is asking
 */
bool ui_kiosk_take_vision_reset(bool *stuck);

/** The colour a screen that covers the panel clears it to.
 *  @ctx any | non-blocking | panel byte order, from the one palette
 */
uint16_t ui_kiosk_ground_rgb565(void);

/** Say which overlay the panel is now showing.
 *  @ctx cam_task | non-blocking | a repaint that skips this call stalls the
 *       screens on purpose: the next map is only a delta against this one
 */
void ui_kiosk_shown(uint32_t serial);

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

/** The guide frame the scan screen draws, which svc_vision judges faces against.
 *  @ctx any | non-blocking | a constant, answers ahead of ui_kiosk_init
 *  @param out x1, y1, x2, y2 in panel pixels
 */
void ui_kiosk_guide(int16_t out[4]);

/** Wait for ui_task to publish an overlay newer than the last one waited on.
 *  @ctx cam_task | blocking up to timeout_ms | one waiter only
 *  @ret true when a new overlay is ready to be shown
 */
bool ui_kiosk_wait_publish(uint32_t timeout_ms);

#ifdef __cplusplus
}
#endif
