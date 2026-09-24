/** The eight screens and the manager that owns them (KEHOACH 4.5.5h).
 *  @ctx ui_task | non-blocking | screens are built once and never destroyed
 */
#pragma once

#include <stdint.h>

#include "app_events.h"
#include "canvas.hpp"
#include "storage_format.h"
#include "ui_kiosk.h"

namespace ui {

enum class ScreenId {
    Scan = 0,
    Menu,
    Enrol,
    Capture,
    People,
    Settings,
    Wifi,
    Device,
    Count,
};

/** What the kiosk knows about the person in front of it, as a screen sees it. */
struct Sight {
    bool face;                            // the detector has one
    ui_kiosk_stage_t stage;               // what svc_vision is doing with it
    float yaw;                            // 0 facing the lens (KEHOACH 4.5.5h.2)
    uint32_t samples;                     // detects landed, so a screen can filter
    app_ui_verdict_t verdict;             // on the glass until its clock runs out
    uint32_t track;                       // which face the pipeline is on
    uint32_t verdict_track;               // which face the last verdict is about
    uint32_t employee_id;
    char name[STORAGE_NAME_CAP];
};

class Screen {
public:
    virtual ~Screen() = default;
    virtual void on_enter() noexcept {}
    virtual void on_exit() noexcept {}

    /** @ret true when the screen wants repainting */
    virtual bool on_touch(int x, int y, bool down) noexcept { return false; }
    virtual bool tick(uint32_t dt_ms, const Sight &seen) noexcept { return false; }
    virtual void paint(Canvas &to, const Sight &seen) noexcept = 0;

    /** True when the screen covers the panel and the preview must not show. */
    virtual bool opaque() const noexcept { return false; }
};

class ScreenManager {
public:
    void attach(ScreenId id, Screen *screen) noexcept { screens_[(int)id] = screen; }
    void go(ScreenId id) noexcept;
    ScreenId at() const noexcept { return at_; }
    Screen *current() const noexcept { return screens_[(int)at_]; }

private:
    Screen *screens_[(int)ScreenId::Count] = {};
    ScreenId at_ = ScreenId::Scan;
};

/** The one manager, so a screen can send the kiosk somewhere else. */
ScreenManager &manager() noexcept;

/** Where the enrol flow leaves its answer for main to act on. */
struct EnrolRequest {
    bool waiting;
    uint32_t employee_id;
    uint16_t template_idx;
    char name[STORAGE_NAME_CAP];
    float yaw_min;                        // the turn this sample asks for
    float yaw_max;
};

EnrolRequest &enrol_request() noexcept;

/** Where the people screen leaves the employee it wants gone. */
struct RemoveRequest {
    bool waiting;
    uint32_t employee_id;
};

RemoveRequest &remove_request() noexcept;

/** The capture screen counts a sample when the pipeline really kept one. */
void enrol_kept() noexcept;

/** Whether the capture screen holds all of its samples. */
bool enrol_complete() noexcept;

/** The capture screen counts a sample the pipeline turned away as a spoof. */
void enrol_refused() noexcept;

/** What the device page shows, handed down by main (KEHOACH 4.5.4 rule 2). */
struct Facts {
    int count;
    ui_kiosk_fact_t row[UI_KIOSK_FACTS];
};

Facts &facts() noexcept;

/** Why the preview wants svc_vision started over (KEHOACH 4.5.5h.1). */
enum class Restart : uint8_t {
    No = 0,
    Returned,                             // the operator came back from a menu
    Stuck,                                // a face outlived every verdict it is owed
};

Restart &vision_reset() noexcept;

/** Where the radio stands, as the settings row shows it. */
ui_kiosk_net_t &net() noexcept;

/** The two levels the sliders sit at, and whether main has yet to hear about it. */
struct Level {
    uint8_t percent;
    bool changed;
    bool settled;
};

Level &brightness() noexcept;
Level &volume() noexcept;

/** Set when the settings screen took a language main has yet to write to NVS. */
bool &language_changed() noexcept;

/** What the people screen shows, handed down by main (KEHOACH 4.5.4 rule 2). */
struct People {
    bool wanted;
    int count;
    ui_kiosk_person_t row[UI_KIOSK_PEOPLE_ROWS];
};

People &people() noexcept;

/** The employees the server assigned but nobody has enrolled yet (KEHOACH 7.5). */
struct Pending {
    bool wanted;
    int count;
    ui_kiosk_pending_t row[UI_KIOSK_PENDING_ROWS];
};

Pending &pending() noexcept;

/** What the wifi screen shows and what it wants, handed down by main. */
struct Networks {
    bool wanted;
    bool fresh;
    int count;
    ui_kiosk_ap_t row[UI_KIOSK_WIFI_ROWS];
};

Networks &networks() noexcept;

/** Where the wifi screen leaves the network the operator picked. */
struct JoinRequest {
    bool waiting;
    bool answered;
    bool stored;                          // join on the passphrase already in NVS
    esp_err_t result;
    char ssid[33];
    char pass[UI_KIOSK_WIFI_PASS_CAP];
};

JoinRequest &join_request() noexcept;

/** Tell the people screen its list has been refreshed, so a row that asked to
 *  go stops saying so whether or not the table let it.
 */
void people_delivered() noexcept;

/** The guide frame the scan screen draws, x1, y1, x2, y2 in panel pixels. */
void guide_box(int16_t out[4]) noexcept;

Screen *scan_screen() noexcept;
Screen *menu_screen() noexcept;
Screen *enrol_screen() noexcept;
Screen *capture_screen() noexcept;
Screen *people_screen() noexcept;
Screen *settings_screen() noexcept;
Screen *wifi_screen() noexcept;
Screen *device_screen() noexcept;

}  // namespace ui
