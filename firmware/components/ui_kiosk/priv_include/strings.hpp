/** Every sentence the kiosk shows, in both languages (CLAUDE.md 3.1).
 *  @ctx any | non-blocking | the table is const data in flash, so no lock
 */
#pragma once

#include <stdint.h>

namespace ui {

enum class Lang : uint8_t {
    Vi = 0,
    En,
    Count,
};

enum class StrId : uint16_t {
    ScanFrame = 0,
    ScanTooFar,
    ScanTooClose,
    ScanWorking,
    ScanSpoof,
    ScanUnknown,
    ScanDenied,
    ScanCheckedIn,
    ScanCodeFmt,                          // takes the employee id
    TicketWaitingFmt,                     // takes the device id
    TicketClaimFmt,                       // takes the claim code, grouped 3 + 3
    TicketRefused,
    TicketNoToken,
    TicketOffline,
    UpdateFetchingFmt,                    // takes the percentage
    UpdateRestarting,

    MenuTitle,
    MenuEnrol,
    MenuPeople,
    MenuSettings,
    MenuClose,

    SettingsLanguage,
    SettingsDevice,
    SettingsNotJoined,
    SettingsDisplay,

    DeviceNoFacts,
    DeviceVersion,
    DeviceId,
    DeviceEnrolled,
    DeviceRecords,
    DeviceWifiDrops,
    DeviceWakeWithin,
    DeviceMinFace,
    DeviceRamFree,

    EnrolNobody,
    EnrolNobodyHint,

    CaptureLookAhead,
    CaptureTurnLeft,
    CaptureTurnRight,
    CaptureTurnBack,
    CaptureHold,
    CaptureNoSample,
    CaptureAddedFmt,                      // takes the person's name
    CaptureSpoofFmt,                      // takes refusals so far and the budget
    CaptureConfirm,
    CaptureRetry,
    CaptureQuit,
    CaptureCancel,

    PeopleEmpty,
    PeopleTemplatesFmt,                   // takes the template count
    PeopleUnnamed,
    PersonRetake,
    PersonRemove,
    PersonConfirm,
    PersonNoRoom,
    EnrolRetake,

    WifiScanning,
    WifiNone,
    WifiJoining,
    WifiWrongPass,
    WifiJoined,
    WifiSaved,
    WifiPassword,
    WifiJoin,

    Count,
};

/** The sentence for an id, in whichever language the kiosk is set to.
 *  @ctx any | non-blocking | never NULL, and the pointer outlives the caller
 */
const char *text(StrId id) noexcept;

/** Point the catalogue at a language; screens repaint on their next tick.
 *  @ctx task | non-blocking
 */
void set_language(Lang lang) noexcept;

/** @ctx any | non-blocking */
Lang language() noexcept;

/** How a language is spelled in NVS ui/lang (KEHOACH 6.2.1).
 *  @ctx any | non-blocking
 */
const char *language_code(Lang lang) noexcept;

/** The two letters on the settings switch, which never change with the setting.
 *  @ctx any | non-blocking | kept apart from the NVS spelling on purpose
 */
const char *language_badge(Lang lang) noexcept;

/** Read that spelling back; an empty or unknown code is Vi (KEHOACH 6.2.1).
 *  @ctx any | non-blocking | NULL reads as absent
 */
Lang language_of(const char *code) noexcept;

}  // namespace ui
