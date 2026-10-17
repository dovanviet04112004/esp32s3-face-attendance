#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <map>
#include <string>
#include <vector>

#include "core/espdl/espdl_model.hpp"
#include "dl_model_base.hpp"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp32s3/rom/cache.h"
#include "esp_heap_caps.h"
#include "esp_private/esp_psram_extram.h"
#include "esp_timer.h"
#include "sys_storage.h"
#include "unity.h"

extern const uint8_t kFramesStart[] asm("_binary_frames_gold_start");
extern const uint8_t kFramesEnd[] asm("_binary_frames_gold_end");

namespace {

constexpr size_t kNameBytes = 32;
constexpr size_t kMaxDims = 4;
constexpr size_t kFileHead = 12;
constexpr size_t kRecordHead = kNameBytes + 4 * (3 + kMaxDims);
constexpr uint32_t kInt32 = 2;
constexpr uintptr_t kMmuPageBytes = 0x10000;

struct Record {
    std::string name;
    uint32_t dtype;
    uint32_t nbytes;
    const uint8_t *data;
};

// Layout of ml/src/facepipe/export/emit_golden.py: GOLD, version, count, then name[32], dtype,
// ndim, dims[4], nbytes and the payload padded to four bytes, read with memcpy for alignment.
std::vector<Record> read_frames()
{
    std::vector<Record> records;
    TEST_ASSERT_EQUAL_MEMORY_MESSAGE("GOLD", kFramesStart, 4, "frames.gold");
    uint32_t count = 0;
    memcpy(&count, kFramesStart + 8, sizeof(count));
    const uint8_t *at = kFramesStart + kFileHead;
    for (uint32_t i = 0; i < count; ++i) {
        TEST_ASSERT_TRUE(at + kRecordHead <= kFramesEnd);
        char name[kNameBytes + 1] = {};
        memcpy(name, at, kNameBytes);
        Record record = {name, 0, 0, nullptr};
        memcpy(&record.dtype, at + kNameBytes, sizeof(uint32_t));
        memcpy(&record.nbytes, at + kRecordHead - sizeof(uint32_t), sizeof(uint32_t));
        record.data = at + kRecordHead;
        at = record.data + ((record.nbytes + 3u) & ~3u);
        TEST_ASSERT_TRUE(at <= kFramesEnd);
        records.push_back(record);
    }
    return records;
}

const Record *find(const std::vector<Record> &records, const std::string &name)
{
    for (const Record &record : records) {
        if (record.name == name) {
            return &record;
        }
    }
    return nullptr;
}

int exponent_in(const std::vector<Record> &records, const std::string &name)
{
    const Record *record = find(records, name);
    TEST_ASSERT_NOT_NULL_MESSAGE(record, name.c_str());
    TEST_ASSERT_EQUAL(kInt32, record->dtype);
    int32_t exponent = 0;
    memcpy(&exponent, record->data, sizeof(exponent));
    return exponent;
}

size_t elements(const dl::TensorBase *tensor)
{
    size_t count = 1;
    for (const int dim : tensor->shape) {
        count *= static_cast<size_t>(dim);
    }
    return count;
}

const storage_models_header_t *open_image()
{
    const esp_err_t up = sys_storage_init();
    TEST_ASSERT_TRUE(up == ESP_OK || up == ESP_ERR_INVALID_STATE);
    const storage_models_header_t *header = nullptr;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_models_open(&header));
    return header;
}

std::string entry_name(const storage_models_header_t *header, uint32_t index)
{
    char name[STORAGE_MODEL_NAME_LEN + 1] = {};
    memcpy(name, header->entry[index].name, STORAGE_MODEL_NAME_LEN);
    return name;
}

const char *blob_of(const std::string &name, size_t *size)
{
    const void *data = nullptr;
    TEST_ASSERT_EQUAL_MESSAGE(ESP_OK, sys_storage_model_find(name.c_str(), &data, size, nullptr), name.c_str());
    TEST_ASSERT_EQUAL_MEMORY_MESSAGE("EDL2", data, 4, name.c_str());
    return static_cast<const char *>(data);
}

struct Pass {
    size_t frames = 0;
    size_t off = 0;
    size_t values = 0;
    int worst = 0;
    int64_t total_us = 0;
    int64_t peak_us = 0;
};

Pass run_frames(dl::Model &model, const std::vector<Record> &records, dl::TensorBase *input)
{
    Pass pass;
    std::map<std::string, dl::TensorBase *> &outputs = model.get_outputs();
    for (const Record *x = find(records, "x0"); x != nullptr; x = find(records, "x" + std::to_string(pass.frames))) {
        TEST_ASSERT_EQUAL(elements(input), x->nbytes);
        memcpy(input->data, x->data, x->nbytes);
        const int64_t started = esp_timer_get_time();
        model.run();
        const int64_t took = esp_timer_get_time() - started;
        pass.total_us += took;
        pass.peak_us = took > pass.peak_us ? took : pass.peak_us;
        for (auto &[out_name, tensor] : outputs) {
            const std::string key = "y" + std::to_string(pass.frames) + "." + out_name;
            const Record *want = find(records, key);
            TEST_ASSERT_NOT_NULL_MESSAGE(want, key.c_str());
            TEST_ASSERT_EQUAL_MESSAGE(elements(tensor), want->nbytes, key.c_str());
            const int8_t *got = static_cast<const int8_t *>(tensor->data);
            const int8_t *expected = reinterpret_cast<const int8_t *>(want->data);
            for (size_t k = 0; k < want->nbytes; ++k) {
                const int delta = abs(got[k] - expected[k]);
                pass.off += delta != 0 ? 1 : 0;
                pass.worst = delta > pass.worst ? delta : pass.worst;
            }
            pass.values += want->nbytes;
        }
        ++pass.frames;
    }
    TEST_ASSERT_GREATER_THAN(0, pass.frames);
    return pass;
}

long long mean_us(const Pass &pass)
{
    return static_cast<long long>(pass.total_us / static_cast<int64_t>(pass.frames));
}

// Autoload stays on the mapped PSRAM: the whole 32 MB data window panics with a Dcache preload configuration error.
autoload_region_config mapped_psram()
{
    void *inside = heap_caps_malloc(1, MALLOC_CAP_SPIRAM);
    TEST_ASSERT_NOT_NULL(inside);
    uintptr_t low = reinterpret_cast<uintptr_t>(inside) & ~(kMmuPageBytes - 1);
    uintptr_t high = low;
    heap_caps_free(inside);
    while (esp_psram_check_ptr_addr(reinterpret_cast<const void *>(low - kMmuPageBytes))) {
        low -= kMmuPageBytes;
    }
    while (esp_psram_check_ptr_addr(reinterpret_cast<const void *>(high))) {
        high += kMmuPageBytes;
    }
    return {CACHE_AUTOLOAD_REGION0, 1, static_cast<uint32_t>(low), static_cast<uint32_t>(high - low)};
}

// Measurement only: ESP-IDF resumes the data cache with autoload off and forbids apps these calls.
void autoload_psram(uint8_t trigger, int lines)
{
    const autoload_region_config psram = mapped_psram();
    TEST_ASSERT_EQUAL(0, Cache_Config_DCache_Region_Autoload(&psram));
    const autoload_config load = {1, CACHE_AUTOLOAD_POSITIVE, trigger, static_cast<uint8_t>(CACHE_AUTOLOAD_STEP(lines))};
    Cache_Config_DCache_Autoload(&load);
    Cache_Enable_DCache_Autoload();
}

}  // namespace

TEST_CASE("every graph of the probe image passes model->test()", "[probe]")
{
    const storage_models_header_t *header = open_image();
    int failed = 0;
    for (uint32_t i = 0; i < header->count; ++i) {
        const std::string name = entry_name(header, i);
        size_t size = 0;
        dl::Model model(blob_of(name, &size), fbs::MODEL_LOCATION_IN_FLASH_RODATA, 0, dl::MEMORY_MANAGER_GREEDY,
                        nullptr, true);
        TEST_ASSERT_FALSE_MESSAGE(model.get_outputs().empty(), name.c_str());
        const esp_err_t tested = model.test();
        printf("probe %s: %u KB, model->test() %s\n", name.c_str(), static_cast<unsigned>(size / 1024),
               tested == ESP_OK ? "PASS" : "FAIL");
        failed += tested == ESP_OK ? 0 : 1;
    }
    TEST_ASSERT_EQUAL(0, failed);
}

TEST_CASE("the whole graph matches the simulation on every real frame", "[probe]")
{
    const storage_models_header_t *header = open_image();
    const std::string name = entry_name(header, 0);
    if (name.find("_c") != std::string::npos) {
        printf("probe %s: this image holds cuts only, the frames ran with the first one\n", name.c_str());
        return;
    }
    const std::vector<Record> records = read_frames();
    size_t size = 0;
    dl::Model model(blob_of(name, &size), fbs::MODEL_LOCATION_IN_FLASH_RODATA, 0, dl::MEMORY_MANAGER_GREEDY,
                    nullptr, true);
    std::map<std::string, dl::TensorBase *> &inputs = model.get_inputs();
    TEST_ASSERT_EQUAL(1, inputs.size());
    dl::TensorBase *input = inputs.begin()->second;
    TEST_ASSERT_EQUAL(exponent_in(records, "in_exp"), input->get_exponent());
    for (auto &[out_name, tensor] : model.get_outputs()) {
        TEST_ASSERT_EQUAL_MESSAGE(exponent_in(records, "exp." + out_name), tensor->get_exponent(), out_name.c_str());
    }
    const Pass pass = run_frames(model, records, input);
    printf("probe %s: %u frames, %u of %u values off the simulation, worst |board - simulation| %d, "
           "%lld us mean, %lld us peak a frame\n",
           name.c_str(), static_cast<unsigned>(pass.frames), static_cast<unsigned>(pass.off),
           static_cast<unsigned>(pass.values), pass.worst, mean_us(pass), static_cast<long long>(pass.peak_us));
    model.profile(false);
    const struct {
        uint8_t trigger;
        const char *on;
        int lines;
    } settings[] = {{CACHE_AUTOLOAD_MISS_TRIGGER, "miss", 1},
                    {CACHE_AUTOLOAD_MISS_TRIGGER, "miss", 4},
                    {CACHE_AUTOLOAD_BOTH_TRIGGER, "miss and hit", 4}};
    for (const auto &setting : settings) {
        autoload_psram(setting.trigger, setting.lines);
        const Pass ahead = run_frames(model, records, input);
        Cache_Disable_DCache_Autoload();
        printf("probe %s autoload %d lines on %s: %u of %u values off the simulation, %lld us mean, "
               "%lld us peak a frame\n",
               name.c_str(), setting.lines, setting.on, static_cast<unsigned>(ahead.off),
               static_cast<unsigned>(ahead.values), mean_us(ahead), static_cast<long long>(ahead.peak_us));
    }
    TEST_ASSERT_EQUAL(0, pass.off);
}

extern "C" void app_main(void)
{
    // The console drops what overflows its 64-byte usb fifo unless a driver stands behind it.
    usb_serial_jtag_driver_config_t console = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    if (usb_serial_jtag_driver_install(&console) == ESP_OK) {
        usb_serial_jtag_vfs_use_driver();
    }
    ai::register_espdl_modules();
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
}
