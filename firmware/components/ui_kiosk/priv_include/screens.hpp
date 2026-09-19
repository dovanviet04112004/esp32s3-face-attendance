/** The five screens and the manager that owns them (KEHOACH 4.5.5h).
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
    Count,
};

/** Where the tracked face sits against the guide frame. */

/** What the kiosk knows about the person in front of it, as a screen sees it. */
struct Sight {
    bool face;                            // the detector has one
    ui_kiosk_stage_t stage;               // what svc_vision is doing with it
    float yaw;                            // 0 facing the lens (KEHOACH 4.5.5h.2)
    uint32_t samples;                     // detects landed, so a screen can filter
    app_ui_verdict_t verdict;
    uint32_t track;                       // which face the pipeline is on
    uint32_t employee_id;
    char name[STORAGE_NAME_CAP];
};

/** Read a face box already mapped to panel pixels against the guide frame.
 *  @ctx any | non-blocking | the guide rectangle lives with the screens
 */

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

/** One line of the settings page, handed down by main (KEHOACH 4.5.5h.4). */
void settings_line(int at, const char *text) noexcept;

/** What the people screen shows, handed down by main (KEHOACH 4.5.4 rule 2). */
struct People {
    bool wanted;
    int count;
    ui_kiosk_person_t row[UI_KIOSK_PEOPLE_ROWS];
};

People &people() noexcept;

/** Tell the people screen its list has been refreshed, so a row that asked to
 *  go stops saying so whether or not the table let it.
 */
void people_delivered() noexcept;

Screen *scan_screen() noexcept;
Screen *menu_screen() noexcept;
Screen *enrol_screen() noexcept;
Screen *capture_screen() noexcept;
Screen *people_screen() noexcept;
Screen *settings_screen() noexcept;

}  // namespace ui
