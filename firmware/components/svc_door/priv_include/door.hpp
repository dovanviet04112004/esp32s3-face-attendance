/** The door interface and both things that implement it (KEHOACH 4.5.5e).
 *  @ctx task | open and close of the servo door take m_door
 */
#pragma once

#include <atomic>
#include <stdint.h>

#include "esp_err.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

namespace door {

class IDoor {
public:
    virtual ~IDoor() = default;
    virtual esp_err_t open(uint32_t hold_ms) noexcept = 0;
    virtual esp_err_t close() noexcept = 0;
    virtual bool is_open() const noexcept = 0;
};

class ServoDoor final : public IDoor {
public:
    ServoDoor() = default;
    ServoDoor(const ServoDoor &) = delete;
    ServoDoor &operator=(const ServoDoor &) = delete;

    /** Create m_door and the hold timer, then lower the arm.
     *  @ctx task | non-blocking | call after drv_servo_init
     */
    esp_err_t init() noexcept;
    esp_err_t open(uint32_t hold_ms) noexcept override;
    esp_err_t close() noexcept override;
    bool is_open() const noexcept override;

private:
    enum class Arm : uint8_t { Limp, Raised, Lowering };

    static void on_timer(void *arg);
    esp_err_t lower() noexcept;
    esp_err_t fire_after(uint32_t delay_ms) noexcept;

    SemaphoreHandle_t mutex_ = nullptr;
    esp_timer_handle_t timer_ = nullptr;
    std::atomic<Arm> arm_{Arm::Limp};
};

class FakeDoor final : public IDoor {
public:
    esp_err_t open(uint32_t hold_ms) noexcept override;
    esp_err_t close() noexcept override;
    bool is_open() const noexcept override;
    uint32_t open_calls() const noexcept { return open_calls_; }
    uint32_t close_calls() const noexcept { return close_calls_; }
    uint32_t last_hold_ms() const noexcept { return last_hold_ms_; }

private:
    bool open_ = false;
    uint32_t open_calls_ = 0;
    uint32_t close_calls_ = 0;
    uint32_t last_hold_ms_ = 0;
};

}  // namespace door
