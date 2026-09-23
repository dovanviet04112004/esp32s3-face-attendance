/** One ESP-DL graph over an .espdl blob in the mapped models partition.
 *  Knows no branch by name (KEHOACH 4.5.6): a facade picks the entry and reads
 *  the outputs through TensorView, as the TFLM facade does.
 *  @ctx task | init and invoke block | one instance per branch, built once
 */
#pragma once

#include <stddef.h>

#include "esp_err.h"
#include "tensor_view.hpp"

namespace dl {
class Model;
class TensorBase;
}  // namespace dl

namespace ai {

/** A TensorBase seen through TensorView: scale 2^exponent, zero point 0, NHWC.
 *  @ctx any | non-blocking | invalid unless int8 of rank 4 or less
 */
TensorView view_of(dl::TensorBase *tensor) noexcept;

class EspdlModel {
public:
    EspdlModel() = default;
    // dl::Model owns the tensors every TensorView points into.
    EspdlModel(const EspdlModel &) = delete;
    EspdlModel &operator=(const EspdlModel &) = delete;

    /** Build the graph from an .espdl blob that stays mapped until reboot.
     *  @param copy_weights true copies the parameters to PSRAM (AI_WEIGHTS_PSRAM_*)
     *  @ret ESP_OK | ESP_ERR_INVALID_ARG | ESP_ERR_NO_MEM | ESP_ERR_NOT_SUPPORTED when ESP-DL stopped
     *       part-way, which an operator without a module causes
     */
    esp_err_t init(const void *blob, const char *name, bool copy_weights) noexcept;
    TensorView input() noexcept;
    TensorView output(size_t index) noexcept;
    size_t output_count() noexcept;
    esp_err_t invoke() noexcept;
    bool ready() const noexcept { return model_ != nullptr; }

private:
    dl::Model *model_ = nullptr;
    const char *name_ = "";
};

}  // namespace ai
