#include "door.hpp"

namespace door {

esp_err_t FakeDoor::open(uint32_t hold_ms) noexcept
{
    open_ = true;
    ++open_calls_;
    last_hold_ms_ = hold_ms;
    return ESP_OK;
}

esp_err_t FakeDoor::close() noexcept
{
    open_ = false;
    ++close_calls_;
    return ESP_OK;
}

bool FakeDoor::is_open() const noexcept
{
    return open_;
}

}  // namespace door
