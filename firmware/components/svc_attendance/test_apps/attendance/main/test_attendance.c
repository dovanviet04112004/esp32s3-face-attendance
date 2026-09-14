#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "storage_format.h"
#include "svc_attendance.h"
#include "svc_door.h"
#include "sys_storage.h"
#include "unity.h"

#define DEDUP_MIN 5
#define EMPLOYEE_A 4001
#define EMPLOYEE_B 4002
#define MATCH_SCORE 0.82f
#define LIVE_SCORE 0.95f
#define NO_SPOOF_SCORE (-1.0f)
#define GRANT_HOLD_MS 2500
#define DENY_HOLD_MS 2000
#define COOLDOWN_MS 1500
#define MINUTE_MS 60000

static int64_t s_now_ms = 1000000;

static void machine_up(bool allow_no_spoof)
{
    const esp_err_t storage = sys_storage_init();
    TEST_ASSERT_TRUE(storage == ESP_OK || storage == ESP_ERR_INVALID_STATE);
    const svc_attendance_policy_t policy = { .dedup_min = DEDUP_MIN,
                                             .allow_no_spoof = allow_no_spoof };
    const esp_err_t err = svc_attendance_init(svc_door_fake(), &policy);
    TEST_ASSERT_TRUE(err == ESP_OK || err == ESP_ERR_INVALID_STATE);
    if (err == ESP_ERR_INVALID_STATE) {
        TEST_ASSERT_EQUAL(ESP_OK, svc_attendance_set_policy(&policy));
    }
}

static svc_vision_result_t event_of(svc_vision_kind_t kind, uint32_t employee, float live)
{
    svc_vision_result_t result = { 0 };
    result.kind = kind;
    result.employee_id = employee;
    result.match_score = MATCH_SCORE;
    result.live_score = live;
    return result;
}

static void feed(svc_vision_kind_t kind, uint32_t employee, float live)
{
    const svc_vision_result_t result = event_of(kind, employee, live);
    TEST_ASSERT_EQUAL(ESP_OK, svc_attendance_on_vision(&result, s_now_ms));
}

// Every case starts from Idle, and the only way there is through the table.
static void back_to_idle(void)
{
    for (int i = 0; i < 4; ++i) {
        s_now_ms += GRANT_HOLD_MS + DENY_HOLD_MS + COOLDOWN_MS;
        svc_attendance_tick(s_now_ms);
    }
    svc_attendance_on_presence(false);
    TEST_ASSERT_EQUAL(SVC_ATTENDANCE_IDLE, svc_attendance_state());
}

TEST_CASE("presence opens the machine and a match grants", "[svc_attendance]")
{
    machine_up(true);
    back_to_idle();
    TEST_ASSERT_EQUAL(ESP_OK, svc_attendance_on_presence(true));
    TEST_ASSERT_EQUAL(SVC_ATTENDANCE_DETECTING, svc_attendance_state());
    const uint32_t before = svc_attendance_records();
    feed(SVC_VISION_MATCH, EMPLOYEE_A, LIVE_SCORE);
    TEST_ASSERT_EQUAL(SVC_ATTENDANCE_GRANTED, svc_attendance_state());
    TEST_ASSERT_EQUAL(before + 1, svc_attendance_records());
    TEST_ASSERT_TRUE(svc_door_is_open(svc_door_fake()));
}

TEST_CASE("the record carries the fields of section 6.2.5", "[svc_attendance]")
{
    machine_up(true);
    storage_attend_record_t record = { 0 };
    TEST_ASSERT_EQUAL(ESP_OK, svc_attendance_last_record(&record));
    printf("local_id 0x%llX employee %" PRIu32 " ts %lld flags 0x%02X match %u live %u\n",
           (unsigned long long)record.local_id, record.employee_id, record.ts_ms, record.flags,
           record.match_score, record.liveness_score);
    TEST_ASSERT_EQUAL_HEX32(STORAGE_ATTEND_REC_MAGIC, record.magic);
    TEST_ASSERT_EQUAL(EMPLOYEE_A, record.employee_id);
    TEST_ASSERT_EQUAL(210, record.match_score);
    TEST_ASSERT_EQUAL((uint32_t)sys_storage_boot_count(), (uint32_t)(record.local_id >> 32));
    TEST_ASSERT_NOT_EQUAL(0, record.crc32);
    // bit1 is set while nothing has taken the record off the device yet.
    TEST_ASSERT_EQUAL(0x02, record.flags & 0x02);
}

TEST_CASE("the same person inside the window opens the door without a record", "[svc_attendance]")
{
    machine_up(true);
    back_to_idle();
    svc_attendance_on_presence(true);
    const uint32_t before = svc_attendance_records();
    s_now_ms += MINUTE_MS;
    feed(SVC_VISION_MATCH, EMPLOYEE_A, LIVE_SCORE);
    printf("records %" PRIu32 " then %" PRIu32 " one minute later\n", before,
           svc_attendance_records());
    TEST_ASSERT_EQUAL(before, svc_attendance_records());
    TEST_ASSERT_TRUE(svc_door_is_open(svc_door_fake()));
}

TEST_CASE("another person inside the window is stamped", "[svc_attendance]")
{
    machine_up(true);
    back_to_idle();
    svc_attendance_on_presence(true);
    const uint32_t before = svc_attendance_records();
    feed(SVC_VISION_MATCH, EMPLOYEE_B, LIVE_SCORE);
    TEST_ASSERT_EQUAL(before + 1, svc_attendance_records());
}

TEST_CASE("a spoof denies and never reaches the door", "[svc_attendance]")
{
    machine_up(true);
    back_to_idle();
    svc_attendance_on_presence(true);
    svc_door_close(svc_door_fake());
    const uint32_t before = svc_attendance_records();
    feed(SVC_VISION_SPOOF, EMPLOYEE_A, 0.10f);
    TEST_ASSERT_EQUAL(SVC_ATTENDANCE_DENIED, svc_attendance_state());
    TEST_ASSERT_EQUAL(before, svc_attendance_records());
    TEST_ASSERT_FALSE(svc_door_is_open(svc_door_fake()));
}

TEST_CASE("a match with no liveness branch is refused unless the policy allows it",
          "[svc_attendance]")
{
    machine_up(false);
    back_to_idle();
    svc_attendance_on_presence(true);
    svc_door_close(svc_door_fake());
    const uint32_t before = svc_attendance_records();
    feed(SVC_VISION_MATCH, EMPLOYEE_B, NO_SPOOF_SCORE);
    printf("no-spoof match landed in state %d\n", (int)svc_attendance_state());
    TEST_ASSERT_EQUAL(before, svc_attendance_records());
    TEST_ASSERT_FALSE(svc_door_is_open(svc_door_fake()));
}

TEST_CASE("granted walks to cooldown and back to idle on its own", "[svc_attendance]")
{
    machine_up(true);
    back_to_idle();
    svc_attendance_on_presence(true);
    feed(SVC_VISION_MATCH, EMPLOYEE_B, LIVE_SCORE);
    TEST_ASSERT_EQUAL(SVC_ATTENDANCE_GRANTED, svc_attendance_state());
    s_now_ms += GRANT_HOLD_MS + 1;
    svc_attendance_tick(s_now_ms);
    TEST_ASSERT_EQUAL(SVC_ATTENDANCE_COOLDOWN, svc_attendance_state());
    s_now_ms += COOLDOWN_MS + 1;
    svc_attendance_tick(s_now_ms);
    TEST_ASSERT_EQUAL(SVC_ATTENDANCE_IDLE, svc_attendance_state());
}

TEST_CASE("a face that never leaves is granted once, and again after it does",
          "[svc_attendance]")
{
    machine_up(true);
    back_to_idle();
    svc_attendance_on_presence(true);
    feed(SVC_VISION_MATCH, EMPLOYEE_A, LIVE_SCORE);
    TEST_ASSERT_EQUAL(SVC_ATTENDANCE_GRANTED, svc_attendance_state());
    s_now_ms += GRANT_HOLD_MS + 1;
    svc_attendance_tick(s_now_ms);
    s_now_ms += COOLDOWN_MS + 1;
    svc_attendance_tick(s_now_ms);
    TEST_ASSERT_EQUAL(SVC_ATTENDANCE_IDLE, svc_attendance_state());

    svc_door_close(svc_door_fake());
    feed(SVC_VISION_MATCH, EMPLOYEE_A, LIVE_SCORE);
    printf("the same face still there left state %d\n", (int)svc_attendance_state());
    TEST_ASSERT_EQUAL(SVC_ATTENDANCE_IDLE, svc_attendance_state());
    TEST_ASSERT_FALSE(svc_door_is_open(svc_door_fake()));

    feed(SVC_VISION_NO_FACE, 0, LIVE_SCORE);
    feed(SVC_VISION_MATCH, EMPLOYEE_A, LIVE_SCORE);
    TEST_ASSERT_EQUAL(SVC_ATTENDANCE_GRANTED, svc_attendance_state());
    TEST_ASSERT_TRUE(svc_door_is_open(svc_door_fake()));
}

TEST_CASE("a match while idle grants on the spot", "[svc_attendance]")
{
    machine_up(true);
    back_to_idle();
    svc_door_close(svc_door_fake());
    feed(SVC_VISION_MATCH, EMPLOYEE_B, LIVE_SCORE);
    printf("match straight out of idle left state %d\n", (int)svc_attendance_state());
    TEST_ASSERT_EQUAL(SVC_ATTENDANCE_GRANTED, svc_attendance_state());
    TEST_ASSERT_TRUE(svc_door_is_open(svc_door_fake()));
}

TEST_CASE("the refusal hold does not swallow the match behind it", "[svc_attendance]")
{
    machine_up(true);
    back_to_idle();
    svc_door_close(svc_door_fake());
    feed(SVC_VISION_UNKNOWN, 0, LIVE_SCORE);
    TEST_ASSERT_EQUAL(SVC_ATTENDANCE_DENIED, svc_attendance_state());
    s_now_ms += DENY_HOLD_MS / 2;
    feed(SVC_VISION_MATCH, EMPLOYEE_A, LIVE_SCORE);
    TEST_ASSERT_EQUAL(SVC_ATTENDANCE_GRANTED, svc_attendance_state());
    TEST_ASSERT_TRUE(svc_door_is_open(svc_door_fake()));
}

TEST_CASE("an event with no row in this state is dropped", "[svc_attendance]")
{
    machine_up(true);
    back_to_idle();
    const uint32_t before = svc_attendance_records();
    feed(SVC_VISION_NO_FACE, 0, LIVE_SCORE);
    printf("no face while idle left state %d\n", (int)svc_attendance_state());
    TEST_ASSERT_EQUAL(SVC_ATTENDANCE_IDLE, svc_attendance_state());
    const svc_vision_result_t nothing = event_of(SVC_VISION_NONE, 0, LIVE_SCORE);
    TEST_ASSERT_EQUAL(ESP_OK, svc_attendance_on_vision(&nothing, s_now_ms));
    TEST_ASSERT_EQUAL(SVC_ATTENDANCE_IDLE, svc_attendance_state());
    TEST_ASSERT_EQUAL(before, svc_attendance_records());
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
