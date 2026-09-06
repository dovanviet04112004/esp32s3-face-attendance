/** Keeps a flash partition mapped for a scope and unmaps it on the way out.
 *  @ctx task | blocking on construction | one handle per live region
 */
#pragma once

#include "esp_partition.h"

namespace app {

class MmapRegion {
public:
    MmapRegion(const esp_partition_t *part, size_t offset, size_t size) noexcept
    {
        if (part != nullptr &&
            esp_partition_mmap(part, offset, size, ESP_PARTITION_MMAP_DATA, &data_, &handle_) !=
                ESP_OK) {
            data_ = nullptr;
        }
    }

    ~MmapRegion()
    {
        if (data_ != nullptr) {
            esp_partition_munmap(handle_);
        }
    }

    MmapRegion(const MmapRegion &) = delete;
    MmapRegion &operator=(const MmapRegion &) = delete;

    const void *data() const noexcept { return data_; }
    bool mapped() const noexcept { return data_ != nullptr; }

private:
    const void *data_ = nullptr;
    esp_partition_mmap_handle_t handle_ = 0;
};

}  // namespace app
