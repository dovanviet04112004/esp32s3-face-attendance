/** One tensor arena and the allocator the models on it share.
 *  @ctx task | blocking on reserve | reserved once at boot, never released
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "tensorflow/lite/micro/micro_allocator.h"

namespace ai {

class Arena {
public:
    /** Reserve the buffer and place a MicroAllocator at the head of it.
     *  @param caps preferred heap, falling back to PSRAM with a warning
     */
    esp_err_t reserve(size_t bytes, uint32_t caps) noexcept;

    /** Reserve the two halves TFLM keeps apart, activations in internal ram
     *  and the persistent metadata in psram (KEHOACH 3.10).
     */
    esp_err_t reserve_split(size_t head_bytes, size_t tail_bytes) noexcept;

    tflite::MicroAllocator *allocator() const noexcept { return allocator_; }
    size_t size() const noexcept { return size_; }
    size_t used() const noexcept;
    bool internal() const noexcept { return internal_; }

private:
    uint8_t *buffer_ = nullptr;
    uint8_t *tail_buffer_ = nullptr;
    size_t size_ = 0;
    tflite::MicroAllocator *allocator_ = nullptr;
    bool internal_ = false;
};

}  // namespace ai
