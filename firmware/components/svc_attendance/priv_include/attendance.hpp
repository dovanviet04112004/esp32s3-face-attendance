#pragma once

#include <stdint.h>

#include "svc_attendance.h"

namespace attend {

enum class St : uint8_t {
    Idle = SVC_ATTENDANCE_IDLE,
    Detecting = SVC_ATTENDANCE_DETECTING,
    Verifying = SVC_ATTENDANCE_VERIFYING,
    Granted = SVC_ATTENDANCE_GRANTED,
    Denied = SVC_ATTENDANCE_DENIED,
    Cooldown = SVC_ATTENDANCE_COOLDOWN,
};

enum class Ev : uint8_t { PresenceOn, PresenceOff, NoFace, FaceSmall, Spoof, Unknown, Match, Timeout };

enum class Act : uint8_t { None, Watch, Grant, Refuse, Rest };

struct Transition {
    St from;
    Ev on;
    St to;
    Act act;
};

struct Step {
    St to;
    Act act;
    bool moved;
};

// The whole diagram of KEHOACH 4.5.5f, in flash. An event with no row in the
// current state is dropped: vision reports nothing on most frames.
Step next(St from, Ev on) noexcept;

}  // namespace attend
