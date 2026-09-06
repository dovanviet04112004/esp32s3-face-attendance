/** Holds a FreeRTOS mutex for a scope and never forgets to give it back.
 *  @ctx task | blocking on construction | takes the mutex it is given
 */
#pragma once

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

namespace app {

class LockGuard {
public:
    LockGuard(SemaphoreHandle_t mutex, uint32_t timeout_ms) noexcept
        : mutex_(mutex), held_(xSemaphoreTake(mutex, pdMS_TO_TICKS(timeout_ms)) == pdTRUE) {}

    ~LockGuard()
    {
        if (held_) {
            xSemaphoreGive(mutex_);
        }
    }

    LockGuard(const LockGuard &) = delete;
    LockGuard &operator=(const LockGuard &) = delete;

    bool held() const noexcept { return held_; }

private:
    SemaphoreHandle_t mutex_;
    bool held_;
};

}  // namespace app
