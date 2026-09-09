#include "door.hpp"

#include "app_config.h"
#include "app_err.h"
#include "drv_servo.h"
#include "esp_log.h"
#include "lock_guard.hpp"

namespace door {

namespace {

const char *TAG = "svc_door";

constexpr uint32_t kLockMs = 50;
// SG90 covers 60 degrees in 0.1 s (SG90 DS), so the arm is home well inside this.
constexpr uint32_t kArriveMs = 400;
constexpr uint64_t kUsPerMs = 1000;

}  // namespace

esp_err_t ServoDoor::init() noexcept
{
    if (mutex_ != nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    mutex_ = xSemaphoreCreateMutex();
    if (mutex_ == nullptr) {
        return ESP_ERR_NO_MEM;
    }
    const esp_timer_create_args_t args = {
        .callback = &ServoDoor::on_timer,
        .arg = this,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "door",
        .skip_unhandled_events = true,
    };
    const esp_err_t created = esp_timer_create(&args, &timer_);
    if (created != ESP_OK) {
        vSemaphoreDelete(mutex_);
        mutex_ = nullptr;
        return created;
    }
    app::LockGuard lock(mutex_, kLockMs);
    return lock.held() ? lower() : ESP_ERR_TIMEOUT;
}

esp_err_t ServoDoor::open(uint32_t hold_ms) noexcept
{
    app::LockGuard lock(mutex_, kLockMs);
    if (!lock.held()) {
        return ESP_ERR_TIMEOUT;
    }
    if (arm_.load() != Arm::Raised) {
        APP_RETURN_ON_ERR(drv_servo_angle(APP_DOOR_OPEN_DEG), TAG, "raise");
        arm_.store(Arm::Raised);
    }
    return fire_after(hold_ms);
}

esp_err_t ServoDoor::close() noexcept
{
    app::LockGuard lock(mutex_, kLockMs);
    if (!lock.held()) {
        return ESP_ERR_TIMEOUT;
    }
    return lower();
}

bool ServoDoor::is_open() const noexcept
{
    return arm_.load() == Arm::Raised;
}

esp_err_t ServoDoor::lower() noexcept
{
    APP_RETURN_ON_ERR(drv_servo_angle(APP_DOOR_CLOSED_DEG), TAG, "lower");
    arm_.store(Arm::Lowering);
    return fire_after(kArriveMs);
}

esp_err_t ServoDoor::fire_after(uint32_t delay_ms) noexcept
{
    // An idle timer makes stop report ESP_ERR_INVALID_STATE, which is the state wanted here.
    esp_timer_stop(timer_);
    return esp_timer_start_once(timer_, static_cast<uint64_t>(delay_ms) * kUsPerMs);
}

void ServoDoor::on_timer(void *arg)
{
    auto *self = static_cast<ServoDoor *>(arg);
    app::LockGuard lock(self->mutex_, kLockMs);
    if (!lock.held()) {
        self->fire_after(kLockMs);
        return;
    }
    switch (self->arm_.load()) {
    case Arm::Raised:
        self->lower();
        break;
    case Arm::Lowering:
        if (drv_servo_release() == ESP_OK) {
            self->arm_.store(Arm::Limp);
        }
        break;
    case Arm::Limp:
        break;
    }
}

}  // namespace door
