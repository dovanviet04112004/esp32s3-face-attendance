/** What every branch model can do, and the half of it none of them repeat.
 *  @ctx task | invoke blocks for the whole graph | one instance per branch
 */
#pragma once

#include <stddef.h>

#include "arena.hpp"
#include "esp_err.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_op_resolver.h"
#include "tensorflow/lite/micro/micro_profiler_interface.h"
#include "tensorflow/lite/schema/schema_generated.h"

namespace ai {

/** The profiler every interpreter reports to, or nullptr when it is off.
 *  @ctx any | non-blocking
 */
tflite::MicroProfilerInterface *profiler() noexcept;

/** Print what one invoke spent per operator and start the count over.
 *  @ctx task | blocking on the console | does nothing when profiling is off
 */
void profiler_report(const char *name) noexcept;

class ITfliteModel {
public:
    virtual ~ITfliteModel() = default;
    virtual esp_err_t init(const tflite::Model *model, Arena &arena) noexcept = 0;
    virtual TfLiteTensor *input(int index) noexcept = 0;
    virtual TfLiteTensor *output(int index) noexcept = 0;
    virtual esp_err_t invoke() noexcept = 0;
    virtual const char *name() const noexcept = 0;
};

class TfliteModelBase : public ITfliteModel {
public:
    TfliteModelBase() = default;
    ~TfliteModelBase() override;
    // interpreter_ points into this object's own storage_, so a copy would
    // leave two owners aimed at one interpreter.
    TfliteModelBase(const TfliteModelBase &) = delete;
    TfliteModelBase &operator=(const TfliteModelBase &) = delete;
    esp_err_t init(const tflite::Model *model, Arena &arena) noexcept override;
    TfLiteTensor *input(int index) noexcept override;
    TfLiteTensor *output(int index) noexcept override;
    esp_err_t invoke() noexcept override;

protected:
    /** The operators this branch registers, owned by the subclass.
     *  @ctx called once from init, and must outlive the interpreter
     */
    virtual tflite::MicroOpResolver &resolver() noexcept = 0;

private:
    // The interpreter has no default constructor and the arena is not ours to
    // spend on it, so it is built in place after the model is known.
    alignas(tflite::MicroInterpreter) uint8_t storage_[sizeof(tflite::MicroInterpreter)] = {};
    tflite::MicroInterpreter *interpreter_ = nullptr;
};

}  // namespace ai
