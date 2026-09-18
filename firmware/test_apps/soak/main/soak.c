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
#define STACK_FLOOR_BYTES 512
#define HEAP_DRIFT_BYTES (32 * 1024)
#define WARMUP_MS 30000
#define SAMPLE_MS 30000
#define SMOKE_MS 60000
#define SOAK_HOURS 24
#define SOAK_MS (SOAK_HOURS * 3600 * 1000)

static TaskStatus_t s_tasks[TASK_SLOTS];

// IDF sizes its own ipc0 and ipc1 to sit a few hundred bytes from full, so the
// floor covers the tasks app_tasks.c creates and the rest is only reported.
static const char *kOwnTasks[] = { "cam", "tof", "ai", "attend", "ui", "touch", "audio", "net" };

typedef struct {
    uint32_t thinnest_bytes;
    char thinnest[configMAX_TASK_NAME_LEN];
    uint32_t internal_free;
    uint32_t psram_free;
    UBaseType_t tasks;
} sample_t;

static bool is_own_task(const char *name)
{
    for (size_t i = 0; i < sizeof(kOwnTasks) / sizeof(kOwnTasks[0]); ++i) {
        if (strcmp(name, kOwnTasks[i]) == 0) {
            return true;
        }
    }
    return false;
}

static void take_sample(sample_t *out)
{
    memset(out, 0, sizeof(*out));
    out->tasks = uxTaskGetSystemState(s_tasks, TASK_SLOTS, NULL);
    out->thinnest_bytes = UINT32_MAX;
    for (UBaseType_t i = 0; i < out->tasks; ++i) {
        const uint32_t free_bytes =
            (uint32_t)s_tasks[i].usStackHighWaterMark * sizeof(StackType_t);
        if (free_bytes < out->thinnest_bytes && is_own_task(s_tasks[i].pcTaskName)) {
            out->thinnest_bytes = free_bytes;
            snprintf(out->thinnest, sizeof(out->thinnest), "%s", s_tasks[i].pcTaskName);
        }
    }
    out->internal_free = (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    out->psram_free = (uint32_t)heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
}

static void print_every_task(void)
{
    const UBaseType_t count = uxTaskGetSystemState(s_tasks, TASK_SLOTS, NULL);
    for (UBaseType_t i = 0; i < count; ++i) {
        printf("  %-12s prio %-2u stack %" PRIu32 " B free\n", s_tasks[i].pcTaskName,
               (unsigned)s_tasks[i].uxCurrentPriority,
               (uint32_t)s_tasks[i].usStackHighWaterMark * sizeof(StackType_t));
    }
}

static void print_sample(int64_t elapsed_ms, const sample_t *now, const sample_t *first)
{
    printf("[%6" PRId64 " s] %u tasks, thinnest %s %" PRIu32 " B, heap %" PRIu32
           " B internal (%+" PRId32 "), %" PRIu32 " KB psram\n",
           elapsed_ms / 1000, (unsigned)now->tasks, now->thinnest, now->thinnest_bytes,
           now->internal_free, (int32_t)now->internal_free - (int32_t)first->internal_free,
           now->psram_free / 1024);
}

// The kiosk itself, not a stand-in: soak numbers only mean something if they
// come off the chain app_boot brings up (KEHOACH 4.5.2).
static void kiosk_up(void)
{
    static bool booted;
    if (booted) {
        return;
    }
    TEST_ASSERT_EQUAL(ESP_OK, app_boot());
    TEST_ASSERT_EQUAL(ESP_OK, app_tasks_start());
    booted = true;
    vTaskDelay(pdMS_TO_TICKS(WARMUP_MS));
}

TEST_CASE("every task holds its stack once the chain is warm", "[soak_smoke]")
{
    kiosk_up();
    sample_t first;
    take_sample(&first);
    print_every_task();
    print_sample(0, &first, &first);
    TEST_ASSERT_GREATER_THAN_UINT32(0, first.tasks);
    TEST_ASSERT_GREATER_THAN_UINT32(STACK_FLOOR_BYTES, first.thinnest_bytes);

    const int64_t started_us = esp_timer_get_time();
    while (esp_timer_get_time() - started_us < (int64_t)SMOKE_MS * 1000) {
        vTaskDelay(pdMS_TO_TICKS(SAMPLE_MS));
        sample_t now;
        take_sample(&now);
        print_sample((esp_timer_get_time() - started_us) / 1000, &now, &first);
        TEST_ASSERT_GREATER_THAN_UINT32(STACK_FLOOR_BYTES, now.thinnest_bytes);
    }
}

TEST_CASE("heap and stacks hold across the soak window", "[soak]")
{
    kiosk_up();
    sample_t first;
    sample_t thinnest;
    take_sample(&first);
    thinnest = first;
    printf("soak window %d h, sample every %d s\n", SOAK_HOURS, SAMPLE_MS / 1000);

    const int64_t started_us = esp_timer_get_time();
    while (esp_timer_get_time() - started_us < (int64_t)SOAK_MS * 1000) {
        vTaskDelay(pdMS_TO_TICKS(SAMPLE_MS));
        sample_t now;
        take_sample(&now);
        const int64_t elapsed_ms = (esp_timer_get_time() - started_us) / 1000;
        // A new low is the only sample worth the full table: it names the task
        // that is still growing its stack.
        if (now.thinnest_bytes < thinnest.thinnest_bytes) {
            thinnest = now;
            print_sample(elapsed_ms, &now, &first);
            print_every_task();
        } else if (elapsed_ms % (SAMPLE_MS * 10) < SAMPLE_MS) {
            print_sample(elapsed_ms, &now, &first);
        }
        TEST_ASSERT_GREATER_THAN_UINT32(STACK_FLOOR_BYTES, now.thinnest_bytes);
        TEST_ASSERT_GREATER_THAN_UINT32(first.internal_free - HEAP_DRIFT_BYTES,
                                        now.internal_free);
    }
    sample_t last;
    take_sample(&last);
    printf("soak done: thinnest %s %" PRIu32 " B, heap %+" PRId32 " B against the first sample\n",
           thinnest.thinnest, thinnest.thinnest_bytes,
           (int32_t)last.internal_free - (int32_t)first.internal_free);
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_tests_by_tag("[soak]", true);
    UNITY_END();
    printf("the %d h window starts now: leave the board powered, reset to stop\n", SOAK_HOURS);
    UNITY_BEGIN();
    unity_run_tests_by_tag("[soak]", false);
    UNITY_END();
}
