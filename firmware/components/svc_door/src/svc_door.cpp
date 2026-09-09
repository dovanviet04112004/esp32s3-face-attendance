#include "svc_door.h"

#include "door.hpp"
#include "esp_log.h"

struct svc_door_s {
    door::IDoor *impl;
    door::FakeDoor *fake;
};

namespace {

const char *TAG = "svc_door";

door::ServoDoor s_servo;
door::FakeDoor s_fake;
svc_door_s s_servo_handle = { &s_servo, nullptr };
svc_door_s s_fake_handle = { &s_fake, &s_fake };
bool s_servo_ready;

}  // namespace

svc_door_t svc_door_servo(void)
{
    if (!s_servo_ready) {
        const esp_err_t err = s_servo.init();
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "servo door: %s", esp_err_to_name(err));
            return nullptr;
        }
        s_servo_ready = true;
    }
    return &s_servo_handle;
}

svc_door_t svc_door_fake(void)
{
    return &s_fake_handle;
}

esp_err_t svc_door_open(svc_door_t door, uint32_t hold_ms)
{
    if (door == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    return door->impl->open(hold_ms);
}

esp_err_t svc_door_close(svc_door_t door)
{
    if (door == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    return door->impl->close();
}

bool svc_door_is_open(svc_door_t door)
{
    return door != nullptr && door->impl->is_open();
}

void svc_door_fake_log(svc_door_t door, svc_door_fake_log_t *out)
{
    if (out == nullptr) {
        return;
    }
    *out = svc_door_fake_log_t{};
    if (door != nullptr && door->fake != nullptr) {
        out->open_calls = door->fake->open_calls();
        out->close_calls = door->fake->close_calls();
        out->last_hold_ms = door->fake->last_hold_ms();
    }
}
