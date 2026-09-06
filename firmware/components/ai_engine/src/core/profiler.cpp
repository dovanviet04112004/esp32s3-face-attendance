#include "tflite_model.hpp"

#include "sdkconfig.h"

#ifdef CONFIG_AI_PROFILING

#include <stdio.h>

#include "tensorflow/lite/micro/micro_profiler.h"

namespace ai {

namespace {

tflite::MicroProfiler s_profiler;

}

tflite::MicroProfilerInterface *profiler() noexcept
{
    return &s_profiler;
}

void profiler_report(const char *name) noexcept
{
    printf("%s ticks per operator\n", name);
    s_profiler.LogTicksPerTagCsv();
    s_profiler.ClearEvents();
}

}  // namespace ai

#else

namespace ai {

tflite::MicroProfilerInterface *profiler() noexcept
{
    return nullptr;
}

void profiler_report(const char *name) noexcept
{
    (void)name;
}

}  // namespace ai

#endif
