#include "arena.hpp"

#include "esp_heap_caps.h"
#include "esp_log.h"

namespace ai {

namespace {

const char *TAG = "ai_arena";

// TFLM plans tensors on the assumption the arena starts 16-byte aligned.
constexpr size_t kAlign = 16;

uint8_t *take(size_t bytes, uint32_t caps)
{
    return static_cast<uint8_t *>(heap_caps_aligned_alloc(kAlign, bytes, caps | MALLOC_CAP_8BIT));
}

}  // namespace

esp_err_t Arena::reserve(size_t bytes, uint32_t caps) noexcept
{
    if (buffer_ != nullptr || bytes < kAlign) {
        return ESP_ERR_INVALID_STATE;
    }
    buffer_ = take(bytes, caps);
    internal_ = buffer_ != nullptr && (caps & MALLOC_CAP_INTERNAL) != 0;
    if (buffer_ == nullptr && (caps & MALLOC_CAP_INTERNAL) != 0) {
        // Detection runs every frame, so psram here costs speed (KEHOACH 3.10).
        ESP_LOGW(TAG, "%u KB needs one run, largest internal block is %u KB, using psram",
                 static_cast<unsigned>(bytes / 1024),
                 static_cast<unsigned>(
                     heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL) / 1024));
        buffer_ = take(bytes, MALLOC_CAP_SPIRAM);
    }
    if (buffer_ == nullptr) {
        return ESP_ERR_NO_MEM;
    }
    allocator_ = tflite::MicroAllocator::Create(buffer_, bytes);
    if (allocator_ == nullptr) {
        heap_caps_free(buffer_);
        buffer_ = nullptr;
        return ESP_ERR_NO_MEM;
    }
    size_ = bytes;
    return ESP_OK;
}

size_t Arena::used() const noexcept
{
    return allocator_ != nullptr ? allocator_->used_bytes() : 0;
}

}  // namespace ai
