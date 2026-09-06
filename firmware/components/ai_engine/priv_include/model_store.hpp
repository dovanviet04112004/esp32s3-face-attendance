/** The models partition seen as a lookup from entry name to a checked graph.
 *  @ctx task | blocking on open | pointers stay valid until reboot
 */
#pragma once

#include <stdint.h>

#include "esp_err.h"
#include "storage_format.h"
#include "tensorflow/lite/schema/schema_generated.h"

namespace ai {

class ModelStore {
public:
    /** Map the active slot through sys_storage and read its header. */
    esp_err_t open() noexcept;

    /** The graph packed under one entry name, or nullptr when it is absent
     *  or carries a schema this build of TFLM does not read.
     */
    const tflite::Model *find(const char *name) const noexcept;

    uint32_t count() const noexcept { return header_ != nullptr ? header_->count : 0; }

private:
    const storage_models_header_t *header_ = nullptr;
};

}  // namespace ai
