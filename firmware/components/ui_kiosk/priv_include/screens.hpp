/** The five screens and the manager that owns them (KEHOACH 4.5.5h).
 *  @ctx ui_task | non-blocking | screens are built once and never destroyed
 */
#pragma once

#include <stdint.h>

#include "app_events.h"
#include "canvas.hpp"
#include "storage_format.h"

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

/** What the kiosk knows about the person in front of it, as a screen sees it. */
struct Sight {
    bool face;                            // the detector has one
    bool close_enough;                    // it clears vision.face_min_px
    bool verifying;                       // the slow models are running on it
    app_ui_verdict_t verdict;
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
};

EnrolRequest &enrol_request() noexcept;

Screen *scan_screen() noexcept;
Screen *menu_screen() noexcept;
Screen *enrol_screen() noexcept;
Screen *capture_screen() noexcept;
Screen *people_screen() noexcept;
Screen *settings_screen() noexcept;

}  // namespace ui
