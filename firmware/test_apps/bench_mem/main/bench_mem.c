#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "app_boot.h"
#include "app_tasks.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "unity.h"

#define TASK_SLOTS 32
#define WARMUP_MS 30000
#define SETTLE_MS 60000
#define SAMPLE_MS 10000
#define KB 1024u
// KEHOACH 6.4 budgets this much internal SRAM to parts that are not up yet.
#define PENDING_KB 267u

static TaskStatus_t s_tasks[TASK_SLOTS];

static void print_floor(const char *when)
{
    const uint32_t internal = (uint32_t)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL);
    const uint32_t psram = (uint32_t)heap_caps_get_minimum_free_size(MALLOC_CAP_SPIRAM);
    printf("  %-10s internal floor %" PRIu32 " B (%" PRIu32 " KB), psram floor %" PRIu32 " KB\n", when,
           internal, internal / KB, psram / KB);
}

static uint32_t thinnest_stack(char *name, size_t cap)
{
    const UBaseType_t count = uxTaskGetSystemState(s_tasks, TASK_SLOTS, NULL);
    uint32_t thinnest = UINT32_MAX;
    for (UBaseType_t i = 0; i < count; ++i) {
        const uint32_t free_bytes = (uint32_t)s_tasks[i].usStackHighWaterMark * sizeof(StackType_t);
        if (free_bytes < thinnest) {
            thinnest = free_bytes;
            snprintf(name, cap, "%s", s_tasks[i].pcTaskName);
        }
    }
    return thinnest;
}

// The kiosk itself, not a stand-in: a floor only means something if it comes
// off the chain app_boot brings up (KEHOACH 4.5.2).
static void kiosk_up(void)
{
    static bool booted;
    if (booted) {
        return;
    }
    print_floor("pre-boot");
    TEST_ASSERT_EQUAL(ESP_OK, app_boot());
    print_floor("post-boot");
    TEST_ASSERT_EQUAL(ESP_OK, app_tasks_start());
    booted = true;
    vTaskDelay(pdMS_TO_TICKS(WARMUP_MS));
}

TEST_CASE("the heap floor under the running kiosk", "[bench_mem]")
{
    kiosk_up();
    const int64_t started_us = esp_timer_get_time();
    while (esp_timer_get_time() - started_us < (int64_t)SETTLE_MS * 1000) {
        vTaskDelay(pdMS_TO_TICKS(SAMPLE_MS));
        print_floor("running");
    }

    const uint32_t internal = (uint32_t)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL);
    const uint32_t psram = (uint32_t)heap_caps_get_minimum_free_size(MALLOC_CAP_SPIRAM);
    const uint32_t largest = (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL);
    printf("  internal floor %" PRIu32 " KB, largest block now %" PRIu32 " KB\n", internal / KB,
           largest / KB);
    printf("  psram floor %" PRIu32 " KB\n", psram / KB);
    printf("  KEHOACH 6.4 still owes %u KB to wifi, lvgl and the crop buffers\n", PENDING_KB);
    TEST_ASSERT_GREATER_THAN_UINT32(0, internal);
    TEST_ASSERT_GREATER_THAN_UINT32(0, psram);
}

TEST_CASE("every task keeps a stack under the running kiosk", "[bench_mem]")
{
    kiosk_up();
    const UBaseType_t count = uxTaskGetSystemState(s_tasks, TASK_SLOTS, NULL);
    for (UBaseType_t i = 0; i < count; ++i) {
        printf("  %-12s prio %-2u stack %" PRIu32 " B free\n", s_tasks[i].pcTaskName,
               (unsigned)s_tasks[i].uxCurrentPriority,
               (uint32_t)s_tasks[i].usStackHighWaterMark * sizeof(StackType_t));
    }
    char name[configMAX_TASK_NAME_LEN] = { 0 };
    const uint32_t thinnest = thinnest_stack(name, sizeof(name));
    printf("  thinnest %s at %" PRIu32 " B\n", name, thinnest);
    TEST_ASSERT_GREATER_THAN_UINT32(0, count);
    TEST_ASSERT_GREATER_THAN_UINT32(0, thinnest);
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
    unity_run_menu();
}
