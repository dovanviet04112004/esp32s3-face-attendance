/** A FreeRTOS queue that only accepts its declared element type.
 *  @ctx task for send/receive, ISR variants marked | non-blocking at zero wait
 */
#pragma once

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

namespace app {

template <typename T, size_t N>
class Queue {
public:
    Queue() noexcept : handle_(xQueueCreate(N, sizeof(T))) {}

    ~Queue()
    {
        if (handle_ != nullptr) {
            vQueueDelete(handle_);
        }
    }

    Queue(const Queue &) = delete;
    Queue &operator=(const Queue &) = delete;

    bool valid() const noexcept { return handle_ != nullptr; }

    bool send(const T &item, uint32_t timeout_ms) noexcept
    {
        return xQueueSend(handle_, &item, pdMS_TO_TICKS(timeout_ms)) == pdTRUE;
    }

    bool receive(T &out, uint32_t timeout_ms) noexcept
    {
        return xQueueReceive(handle_, &out, pdMS_TO_TICKS(timeout_ms)) == pdTRUE;
    }

    /** @ctx isr-safe | sets *woken when a higher priority task is ready */
    bool send_from_isr(const T &item, BaseType_t *woken) noexcept
    {
        return xQueueSendFromISR(handle_, &item, woken) == pdTRUE;
    }

    size_t waiting() const noexcept { return uxQueueMessagesWaiting(handle_); }

private:
    QueueHandle_t handle_;
};

}  // namespace app
