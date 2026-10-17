#include "core/espdl/espdl_mul_add.hpp"

#include <array>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "dl_module_base.hpp"
#include "esp_log.h"
#include "fbs_model.hpp"

extern "C" void ai_engine_mul_add_s8_esp32s3(int8_t *out, const int8_t *x, const int8_t *gate, const int8_t *residual,
                                             const int32_t *run);

namespace ai {

namespace {

const char *TAG = "mul_add";

constexpr size_t kVectorAlign = 16;
constexpr int kChannelStep = 16;
// esp-dl's requantize broadcasts the left scale as one int8, so 2^6 is the largest it holds.
constexpr int kMaxLeftShift = 6;

bool aligned(dl::TensorBase *tensor) noexcept
{
    return reinterpret_cast<uintptr_t>(tensor->get_element_ptr()) % kVectorAlign == 0;
}

// Inputs as esp_ppq_patches.mul_add_from writes them: x [1, H, W, C], its gate [1, 1, 1, C], the
// residual [1, H, W, C]; the product and the residual are both brought onto the output's exponent.
class MulAdd final : public dl::module::Module {
public:
    explicit MulAdd(const char *name) : Module(name, dl::MODULE_NON_INPLACE, dl::QUANT_TYPE_SYMM_8BIT) {}

    std::vector<std::vector<int>> get_output_shape(std::vector<std::vector<int>> &input_shapes) override
    {
        return {input_shapes[0]};
    }

    void forward(dl::ModelContext *context, dl::runtime_mode_t) override
    {
        dl::TensorBase *x = context->get_tensor(m_inputs_index[0]);
        dl::TensorBase *gate = context->get_tensor(m_inputs_index[1]);
        dl::TensorBase *residual = context->get_tensor(m_inputs_index[2]);
        dl::TensorBase *output = context->get_tensor(m_outputs_index[0]);
        if (!built_ && !build(x, gate, residual, output)) {
            return;
        }
        ai_engine_mul_add_s8_esp32s3(output->get_element_ptr<int8_t>(), x->get_element_ptr<int8_t>(),
                                     gate->get_element_ptr<int8_t>(), residual->get_element_ptr<int8_t>(),
                                     run_.data());
    }

    void print() override { ESP_LOGI(TAG, "quant_type: %s.", dl::quant_type_to_string(quant_type)); }

    static dl::module::Module *deserialize(fbs::FbsModel *fbs_model, std::string node_name)
    {
        dl::quant_type_t quant_type = dl::QUANT_TYPE_NONE;
        fbs_model->get_operation_attribute(node_name, "quant_type", quant_type);
        if (quant_type != dl::QUANT_TYPE_SYMM_8BIT) {
            ESP_LOGE(TAG, "%s: only an int8 gate and residual run joined", node_name.c_str());
            return nullptr;
        }
        return new MulAdd(node_name.c_str());
    }

private:
    bool build(dl::TensorBase *x, dl::TensorBase *gate, dl::TensorBase *residual, dl::TensorBase *output)
    {
        const int channels = x->shape[3];
        const int product_shift = output->get_exponent() - x->get_exponent() - gate->get_exponent();
        const int residual_shift = output->get_exponent() - residual->get_exponent();
        if (channels % kChannelStep != 0 || !aligned(x) || !aligned(gate) || !aligned(residual) || !aligned(output) ||
            product_shift < 0 || residual_shift < -kMaxLeftShift) {
            ESP_LOGE(TAG, "%s: %d channels, product shift %d, residual shift %d do not run as one loop", name, channels,
                     product_shift, residual_shift);
            return false;
        }
        run_ = {x->shape[1] * x->shape[2], channels / kChannelStep, product_shift,
                residual_shift > 0 ? residual_shift : 0, residual_shift < 0 ? 1 << -residual_shift : 0};
        built_ = true;
        return true;
    }

    std::array<int32_t, 5> run_ = {};
    bool built_ = false;
};

}  // namespace

dl::module::Module *mul_add_from(fbs::FbsModel *fbs_model, std::string node_name)
{
    return MulAdd::deserialize(fbs_model, std::move(node_name));
}

}  // namespace ai
