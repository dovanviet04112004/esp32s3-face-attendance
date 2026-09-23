#include "attendance.hpp"

namespace attend {

namespace {

constexpr Transition kTable[] = {
    { St::Idle, Ev::PresenceOn, St::Detecting, Act::Watch },
    // A verdict reopens the machine and is acted on here (KEHOACH 4.5.5f).
    { St::Idle, Ev::FaceSmall, St::Detecting, Act::Watch },
    { St::Idle, Ev::Spoof, St::Denied, Act::Refuse },
    { St::Idle, Ev::Unknown, St::Denied, Act::Refuse },
    { St::Idle, Ev::Match, St::Granted, Act::Grant },
    { St::Detecting, Ev::FaceSmall, St::Detecting, Act::None },
    { St::Detecting, Ev::Match, St::Granted, Act::Grant },
    { St::Detecting, Ev::Spoof, St::Denied, Act::Refuse },
    { St::Detecting, Ev::Unknown, St::Denied, Act::Refuse },
    { St::Detecting, Ev::NoFace, St::Idle, Act::Rest },
    { St::Detecting, Ev::PresenceOff, St::Idle, Act::Rest },
    { St::Verifying, Ev::Match, St::Granted, Act::Grant },
    { St::Verifying, Ev::Spoof, St::Denied, Act::Refuse },
    { St::Verifying, Ev::Unknown, St::Denied, Act::Refuse },
    { St::Verifying, Ev::Timeout, St::Detecting, Act::None },
    { St::Granted, Ev::Timeout, St::Cooldown, Act::Rest },
    // The next person must not wait out this one's door (KEHOACH 4.5.5f).
    { St::Granted, Ev::Match, St::Granted, Act::Grant },
    { St::Denied, Ev::Match, St::Granted, Act::Grant },
    { St::Denied, Ev::Timeout, St::Cooldown, Act::Rest },
    { St::Cooldown, Ev::Match, St::Granted, Act::Grant },
    { St::Cooldown, Ev::Timeout, St::Idle, Act::None },
    { St::Cooldown, Ev::PresenceOff, St::Idle, Act::None },
};

}  // namespace

Step next(St from, Ev on) noexcept
{
    for (const Transition &row : kTable) {
        if (row.from == from && row.on == on) {
            return { row.to, row.act, true };
        }
    }
    return { from, Act::None, false };
}

}  // namespace attend
