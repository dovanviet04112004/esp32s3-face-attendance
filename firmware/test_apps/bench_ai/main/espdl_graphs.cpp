#include "sdkconfig.h"

#if CONFIG_AI_RUNTIME_ESPDL

#include <string.h>

#include "dl_model_base.hpp"
#include "esp_heap_caps.h"
#include "sys_storage.h"
#include "unity.h"

namespace {

const char *const kBranches[] = {"detect", "spoof", "recog"};

}  // namespace

// model->test() compares the chip's outputs against the ESP-PPQ simulation the
// file carries, within one int8 step (KEHOACH 3 layer 5); ai_engine has no such call.
TEST_CASE("every espdl graph reproduces the test vector it was exported with", "[bench_ai]")
{
    const esp_err_t up = sys_storage_init();
    TEST_ASSERT_TRUE(up == ESP_OK || up == ESP_ERR_INVALID_STATE);
    const storage_models_header_t *header = nullptr;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_models_open(&header));
    for (const char *branch : kBranches) {
        const void *data = nullptr;
        size_t size = 0;
        if (sys_storage_model_find(branch, &data, &size, nullptr) != ESP_OK) {
            printf("%s: absent from the image\n", branch);
            continue;
        }
        TEST_ASSERT_EQUAL_MEMORY_MESSAGE("EDL2", data, 4, branch);
        dl::Model model(static_cast<const char *>(data), fbs::MODEL_LOCATION_IN_FLASH_RODATA, 0,
                        dl::MEMORY_MANAGER_GREEDY, nullptr, true);
        TEST_ASSERT_FALSE_MESSAGE(model.get_outputs().empty(), branch);
        const esp_err_t tested = model.test();
        printf("%s: %u KB, test %s\n", branch, static_cast<unsigned>(size / 1024), tested == ESP_OK ? "PASS" : "FAIL");
        TEST_ASSERT_EQUAL_MESSAGE(ESP_OK, tested, branch);
    }
}

#endif
