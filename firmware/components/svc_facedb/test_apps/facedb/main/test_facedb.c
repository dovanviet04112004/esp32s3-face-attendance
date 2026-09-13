#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "storage_format.h"
#include "svc_facedb.h"
#include "sys_storage.h"
#include "unity.h"

#define PEOPLE 500
#define TEMPLATES_PER_PERSON 2
#define ENROLLED (PEOPLE * TEMPLATES_PER_PERSON)
#define LOOKUPS 20
#define LOOKUP_BUDGET_US 20000
#define PROBE_ID 250
#define PROBE_IDX 1
#define FLIPPED 40
#define STRANGER_SEED 0xC0FFEEu
#define SELF_TOLERANCE 1e-3f
#define STRANGER_CEILING 0.5f
#define QUALITY 200
#define SCALE 0.0123f
#define PERSIST_TASK_STACK_BYTES 4096
#define PROBE_GAP_MS 50
#define PROBES_DURING_SAVE 10

static int8_t s_emb[STORAGE_EMBED_DIM];
static int8_t s_damaged[STORAGE_EMBED_DIM];
static TaskHandle_t s_waiter;
static esp_err_t s_persist_err;

static uint32_t seed_of(uint32_t employee_id, uint16_t idx)
{
    return employee_id * TEMPLATES_PER_PERSON + idx + 1;
}

static void synth(uint32_t seed, int8_t *out)
{
    // A deterministic generator, so every boot enrols the same templates and
    // the load path can be checked against them without anything else on flash.
    uint32_t x = seed * 2654435761u + 12345u;
    for (size_t i = 0; i < STORAGE_EMBED_DIM; ++i) {
        x = x * 1664525u + 1013904223u;
        const int v = (int)(x >> 24) - 128;
        out[i] = (int8_t)(v == -128 ? -127 : v);
    }
}

static float cosine_ref(const int8_t *a, const int8_t *b)
{
    double dot = 0.0;
    double na = 0.0;
    double nb = 0.0;
    for (size_t i = 0; i < STORAGE_EMBED_DIM; ++i) {
        dot += (double)a[i] * b[i];
        na += (double)a[i] * a[i];
        nb += (double)b[i] * b[i];
    }
    return (float)(dot / sqrt(na * nb));
}

static void enroll_everyone(void)
{
    for (uint32_t id = 1; id <= PEOPLE; ++id) {
        for (uint16_t idx = 0; idx < TEMPLATES_PER_PERSON; ++idx) {
            synth(seed_of(id, idx), s_emb);
            TEST_ASSERT_EQUAL(ESP_OK, svc_facedb_enroll(id, idx, QUALITY, s_emb, SCALE));
        }
    }
}

TEST_CASE("the table opens and serves whatever the last boot persisted", "[svc_facedb]")
{
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_init());
    TEST_ASSERT_EQUAL(ESP_OK, svc_facedb_init());
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, svc_facedb_init());
    const size_t loaded = svc_facedb_count();
    printf("%u active templates loaded from flash\n", (unsigned)loaded);
    if (loaded == 0) {
        TEST_IGNORE_MESSAGE("empty flash: the cases below enrol and persist, boot again to check the load");
    }
    TEST_ASSERT_EQUAL(ENROLLED, loaded);
    svc_facedb_match_t match;
    synth(seed_of(PROBE_ID, PROBE_IDX), s_emb);
    TEST_ASSERT_EQUAL(ESP_OK, svc_facedb_lookup(s_emb, SCALE, &match));
    TEST_ASSERT_EQUAL(PROBE_ID, match.employee_id);
    TEST_ASSERT_EQUAL(PROBE_IDX, match.template_idx);
    printf("persisted table serves employee %u idx %u at %.4f\n", (unsigned)match.employee_id,
           match.template_idx, match.score);
}

TEST_CASE("enrolling everyone twice keeps the count, a repeat replaces in place", "[svc_facedb]")
{
    const int64_t t0 = esp_timer_get_time();
    enroll_everyone();
    printf("%d enrols in %lld ms\n", ENROLLED, (esp_timer_get_time() - t0) / 1000);
    TEST_ASSERT_EQUAL(ENROLLED, svc_facedb_count());
    synth(seed_of(PROBE_ID, PROBE_IDX), s_emb);
    TEST_ASSERT_EQUAL(ESP_OK, svc_facedb_enroll(PROBE_ID, PROBE_IDX, QUALITY, s_emb, SCALE));
    TEST_ASSERT_EQUAL(ENROLLED, svc_facedb_count());
}

TEST_CASE("the exact template scores one, a damaged one still wins, a stranger stays low", "[svc_facedb]")
{
    svc_facedb_match_t match;
    synth(seed_of(PROBE_ID, PROBE_IDX), s_emb);
    TEST_ASSERT_EQUAL(ESP_OK, svc_facedb_lookup(s_emb, SCALE, &match));
    TEST_ASSERT_EQUAL(PROBE_ID, match.employee_id);
    TEST_ASSERT_EQUAL(PROBE_IDX, match.template_idx);
    TEST_ASSERT_FLOAT_WITHIN(SELF_TOLERANCE, 1.0f, match.score);

    memcpy(s_damaged, s_emb, sizeof(s_damaged));
    for (int i = 0; i < FLIPPED; ++i) {
        const size_t at = (size_t)i * (STORAGE_EMBED_DIM / FLIPPED);
        s_damaged[at] = (int8_t)-s_damaged[at];
    }
    TEST_ASSERT_EQUAL(ESP_OK, svc_facedb_lookup(s_damaged, SCALE, &match));
    TEST_ASSERT_EQUAL(PROBE_ID, match.employee_id);
    const float expected = cosine_ref(s_damaged, s_emb);
    printf("damaged template: device %.4f, reference %.4f\n", match.score, expected);
    TEST_ASSERT_FLOAT_WITHIN(SELF_TOLERANCE, expected, match.score);

    synth(STRANGER_SEED, s_emb);
    TEST_ASSERT_EQUAL(ESP_OK, svc_facedb_lookup(s_emb, SCALE, &match));
    printf("stranger: closest is employee %u at %.4f\n", (unsigned)match.employee_id, match.score);
    TEST_ASSERT_TRUE(match.score < STRANGER_CEILING);
}

TEST_CASE("a lookup over the full table fits the 20 ms budget", "[svc_facedb]")
{
    svc_facedb_match_t match;
    int64_t total_us = 0;
    for (int i = 0; i < LOOKUPS; ++i) {
        const uint32_t id = 1 + (uint32_t)i * 7;
        synth(seed_of(id, (uint16_t)(i & 1)), s_emb);
        const int64_t t0 = esp_timer_get_time();
        TEST_ASSERT_EQUAL(ESP_OK, svc_facedb_lookup(s_emb, SCALE, &match));
        total_us += esp_timer_get_time() - t0;
        TEST_ASSERT_EQUAL(id, match.employee_id);
    }
    printf("lookup over %d templates: %lld us average\n", ENROLLED, total_us / LOOKUPS);
    TEST_ASSERT_LESS_THAN(LOOKUP_BUDGET_US, (int)(total_us / LOOKUPS));
}

TEST_CASE("removing an employee hides both templates and re-enrolling fills a full table", "[svc_facedb]")
{
    svc_facedb_match_t match;
    TEST_ASSERT_EQUAL(ESP_OK, svc_facedb_remove(PROBE_ID));
    TEST_ASSERT_EQUAL(ESP_ERR_NOT_FOUND, svc_facedb_remove(PROBE_ID));
    TEST_ASSERT_EQUAL(ENROLLED - TEMPLATES_PER_PERSON, svc_facedb_count());
    synth(seed_of(PROBE_ID, PROBE_IDX), s_emb);
    TEST_ASSERT_EQUAL(ESP_OK, svc_facedb_lookup(s_emb, SCALE, &match));
    TEST_ASSERT_NOT_EQUAL(PROBE_ID, match.employee_id);
    TEST_ASSERT_TRUE(match.score < STRANGER_CEILING);
    // The table is at capacity with two dead records, so this append has to compact first.
    for (uint16_t idx = 0; idx < TEMPLATES_PER_PERSON; ++idx) {
        synth(seed_of(PROBE_ID, idx), s_emb);
        TEST_ASSERT_EQUAL(ESP_OK, svc_facedb_enroll(PROBE_ID, idx, QUALITY, s_emb, SCALE));
    }
    TEST_ASSERT_EQUAL(ENROLLED, svc_facedb_count());
    synth(seed_of(PROBE_ID, PROBE_IDX), s_emb);
    TEST_ASSERT_EQUAL(ESP_OK, svc_facedb_lookup(s_emb, SCALE, &match));
    TEST_ASSERT_EQUAL(PROBE_ID, match.employee_id);
}

TEST_CASE("persist writes the whole table and the file on flash agrees with it", "[svc_facedb]")
{
    const int64_t t0 = esp_timer_get_time();
    TEST_ASSERT_EQUAL(ESP_OK, svc_facedb_persist());
    printf("persist of %u templates: %lld ms\n", (unsigned)svc_facedb_count(),
           (esp_timer_get_time() - t0) / 1000);
    storage_file_header_t head;
    FILE *file = fopen(STORAGE_FACES_PATH, "rb");
    TEST_ASSERT_NOT_NULL(file);
    TEST_ASSERT_EQUAL(1, fread(&head, sizeof(head), 1, file));
    fseek(file, 0, SEEK_END);
    const long size = ftell(file);
    fclose(file);
    TEST_ASSERT_EQUAL_HEX32(STORAGE_FACES_MAGIC, head.magic);
    TEST_ASSERT_EQUAL(ENROLLED, head.record_count);
    TEST_ASSERT_EQUAL(sizeof(head) + ENROLLED * sizeof(storage_face_record_t), size);
    printf("main task stack left %u bytes\n", (unsigned)uxTaskGetStackHighWaterMark(NULL));
}

static void persist_task(void *arg)
{
    (void)arg;
    s_persist_err = svc_facedb_persist();
    xTaskNotifyGive(s_waiter);
    vTaskDelete(NULL);
}

TEST_CASE("a lookup keeps answering while the table is written to flash", "[svc_facedb]")
{
    s_waiter = xTaskGetCurrentTaskHandle();
    s_persist_err = ESP_FAIL;
    TEST_ASSERT_EQUAL(pdPASS, xTaskCreate(persist_task, "persist", PERSIST_TASK_STACK_BYTES, NULL,
                                          uxTaskPriorityGet(NULL), NULL));
    svc_facedb_match_t match;
    int64_t worst_us = 0;
    int probes = 0;
    while (ulTaskNotifyTake(pdTRUE, 0) == 0) {
        synth(seed_of(PROBE_ID, PROBE_IDX), s_emb);
        const int64_t t0 = esp_timer_get_time();
        const esp_err_t err = svc_facedb_lookup(s_emb, SCALE, &match);
        const int64_t took_us = esp_timer_get_time() - t0;
        TEST_ASSERT_EQUAL(ESP_OK, err);
        TEST_ASSERT_EQUAL(PROBE_ID, match.employee_id);
        worst_us = took_us > worst_us ? took_us : worst_us;
        ++probes;
        vTaskDelay(pdMS_TO_TICKS(PROBE_GAP_MS));
    }
    printf("%d lookups during the save, worst %lld us\n", probes, worst_us);
    TEST_ASSERT_EQUAL(ESP_OK, s_persist_err);
    TEST_ASSERT_GREATER_OR_EQUAL_INT(PROBES_DURING_SAVE, probes);
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
