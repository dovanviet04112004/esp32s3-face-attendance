#include "espdl_mul_add.hpp"

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "dl_base_add.hpp"
#include "dl_base_elemwise.hpp"
#include "dl_base_mul.hpp"
#include "dl_module_base.hpp"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "fbs_model.hpp"

namespace ai {

namespace {

const char *TAG = "mul_add";

constexpr size_t kVectorAlign = 16;
constexpr int kChannelStep = 16;

// Inputs as esp_ppq_patches.mul_add_from writes them: x [1, H, W, C], its gate [1, 1, 1, C], the
// residual [1, H, W, C]; the product rounds onto the output's exponent, which the residual shares.
class MulAdd final : public dl::module::Module {
public:
    explicit MulAdd(const char *name) : Module(name, dl::MODULE_NON_INPLACE, dl::QUANT_TYPE_SYMM_8BIT) {}

    ~MulAdd() override { heap_caps_free(product_); }

    MulAdd(const MulAdd &) = delete;
    MulAdd &operator=(const MulAdd &) = delete;

    std::vector<std::vector<int>> get_output_shape(std::vector<std::vector<int>> &input_shapes) override
    {
        const std::vector<int> &x = input_shapes[0];
        // esp-dl's planner asks for shapes while the model is built, so the product row is reserved then.
        reserve_product(static_cast<size_t>(x[2]) * x[3]);
        return {x};
    }

    void forward(dl::ModelContext *context, dl::runtime_mode_t) override
    {
        dl::TensorBase *x = context->get_tensor(m_inputs_index[0]);
        dl::TensorBase *gate = context->get_tensor(m_inputs_index[1]);
        dl::TensorBase *residual = context->get_tensor(m_inputs_index[2]);
        dl::TensorBase *output = context->get_tensor(m_outputs_index[0]);
        const int rows = x->shape[1];
        const int width = x->shape[2];
        const int channels = x->shape[3];
        const size_t row_bytes = static_cast<size_t>(width) * channels;
        if (product_ == nullptr || row_bytes > product_bytes_ || channels % kChannelStep != 0 ||
            residual->get_exponent() != output->get_exponent()) {
            ESP_LOGE(TAG, "%s: a %dx%d row does not fit the product row or the residual's grid", name, width,
                     channels);
            return;
        }
        const std::vector<int> row_shape = {1, 1, width, channels};
        int8_t *xs = x->get_element_ptr<int8_t>();
        int8_t *rs = residual->get_element_ptr<int8_t>();
        int8_t *ys = output->get_element_ptr<int8_t>();
        dl::TensorBase x_row(row_shape, xs, x->get_exponent(), x->get_dtype(), false, x->caps);
        dl::TensorBase product(row_shape, product_, output->get_exponent(), output->get_dtype(), false,
                               MALLOC_CAP_SPIRAM);
        dl::TensorBase r_row(row_shape, rs, residual->get_exponent(), residual->get_dtype(), false,
                             residual->caps);
        dl::TensorBase y_row(row_shape, ys, output->get_exponent(), output->get_dtype(), false, output->caps);
        const dl::base::elemwiseArgsType<int8_t> times =
            dl::base::get_elemwise_operation_args<int8_t>(&product, &x_row, gate, dl::RUNTIME_MODE_SINGLE_CORE)[0];
        const dl::base::elemwiseArgsType<int8_t> plus =
            dl::base::get_elemwise_operation_args<int8_t>(&y_row, &product, &r_row, dl::RUNTIME_MODE_SINGLE_CORE)[0];
        for (int r = 0; r < rows; ++r) {
            const size_t at = r * row_bytes;
            dl::base::elemwiseArgsType<int8_t> mul = times;
            mul.input0_element = xs + at;
            dl::base::elemwise_mul(&mul);
            dl::base::elemwiseArgsType<int8_t> add = plus;
            add.input1_element = rs + at;
            add.output_element = ys + at;
            dl::base::elemwise_add(&add);
        }
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
    void reserve_product(size_t bytes) noexcept
    {
        if (bytes <= product_bytes_) {
            return;
        }
        heap_caps_free(product_);
        product_ = static_cast<int8_t *>(heap_caps_aligned_calloc(kVectorAlign, 1, bytes, MALLOC_CAP_SPIRAM));
        product_bytes_ = product_ != nullptr ? bytes : 0;
    }

    int8_t *product_ = nullptr;
    size_t product_bytes_ = 0;
};

}  // namespace

dl::module::Module *mul_add_from(fbs::FbsModel *fbs_model, std::string node_name)
{
    return MulAdd::deserialize(fbs_model, std::move(node_name));
}

}  // namespace ai
