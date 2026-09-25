#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "gen_payload.h"
#include "uplink.hpp"
#include "unity.h"

namespace {

constexpr size_t kRecordCap = 64;
constexpr uint32_t kHeaderBytes = 32;
constexpr uint32_t kAckTimeoutMs = 100;
constexpr const char *kDeviceId = "kiosk-aabbccddeeff";

class FakePersist final : public uplink::IPersist {
public:
    storage_attend_record_t records[kRecordCap] = {};
    size_t count = 0;
    storage_cursor_t cursor = {};
    esp_err_t set_answer = ESP_OK;
    int set_calls = 0;

    FakePersist() noexcept
    {
        cursor.magic = STORAGE_CURSOR_MAGIC;
        cursor.format_ver = STORAGE_CURSOR_VER;
        cursor.offset = kHeaderBytes;
    }

    void push(uint64_t local_id, uint32_t employee_id, uint8_t flags) noexcept
    {
        storage_attend_record_t &rec = records[count++];
        memset(&rec, 0, sizeof(rec));
        rec.magic = STORAGE_ATTEND_REC_MAGIC;
        rec.local_id = local_id;
        rec.employee_id = employee_id;
        rec.ts_ms = 1789000000000 + (int64_t)local_id;
        rec.direction = STORAGE_ATTEND_DIR_IN;
        rec.match_score = (uint16_t)(0.83f * STORAGE_ATTEND_SCORE_ONE);
        rec.liveness_score = (uint16_t)(0.91f * STORAGE_ATTEND_SCORE_ONE);
        rec.flags = flags;
        rec.model_version = 1;
    }

    size_t at() const noexcept
    {
        return (cursor.offset - kHeaderBytes) / sizeof(storage_attend_record_t);
    }

    esp_err_t cursor_get(storage_cursor_t *out) noexcept override
    {
        *out = cursor;
        return ESP_OK;
    }

    esp_err_t cursor_set(const storage_cursor_t *next) noexcept override
    {
        ++set_calls;
        if (set_answer != ESP_OK) {
            return set_answer;
        }
        cursor = *next;
        return ESP_OK;
    }

    esp_err_t read(const storage_cursor_t *from, storage_attend_record_t *out,
                   storage_cursor_t *next) noexcept override
    {
        const size_t index = (from->offset - kHeaderBytes) / sizeof(storage_attend_record_t);
        if (index >= count) {
            return ESP_ERR_NOT_FOUND;
        }
        *out = records[index];
        *next = *from;
        next->offset = from->offset + (uint32_t)sizeof(storage_attend_record_t);
        return ESP_OK;
    }
};

class FakeLink final : public uplink::ILink {
public:
    bool online = true;
    esp_err_t answer = ESP_OK;
    int sends = 0;
    char last[320] = {};

    bool up() const noexcept override { return online; }

    esp_err_t send(const char *payload, size_t len, uint32_t timeout_ms) noexcept override
    {
        (void)timeout_ms;
        ++sends;
        const size_t kept = len < sizeof(last) - 1 ? len : sizeof(last) - 1;
        memcpy(last, payload, kept);
        last[kept] = '\0';
        return answer;
    }
};

struct Rig {
    FakePersist store;
    FakeLink link;
    uplink::UplinkQueue queue{ store, link };

    Rig() { TEST_ASSERT_EQUAL(ESP_OK, queue.init(kDeviceId)); }
};

constexpr uint32_t kThisBoot = 7;
constexpr int64_t kSinceBootMs = 65000;
constexpr int64_t kBootAtMs = 1790406000000;

void push_unclocked(FakePersist &store, uint32_t boot)
{
    store.push(((uint64_t)boot << 32) | 1u, 42, STORAGE_ATTEND_FLAG_NO_NTP);
    store.records[store.count - 1].ts_ms = kSinceBootMs;
}

uplink::BootClock boot_clock(bool placed, bool wait)
{
    uplink::BootClock clock;
    clock.boot = kThisBoot;
    clock.placed = placed;
    clock.boot_at_ms = placed ? kBootAtMs : 0;
    clock.wait = wait;
    return clock;
}

attendance_record_t sent(const FakeLink &link)
{
    cJSON *root = cJSON_Parse(link.last);
    attendance_record_t wire = {};
    const bool parsed = root != nullptr && attendance_record_from_json(root, &wire);
    cJSON_Delete(root);
    TEST_ASSERT_TRUE(parsed);
    return wire;
}

}  // namespace

TEST_CASE("a stamp this boot took with no clock leaves placed and still flagged", "[svc_sync]")
{
    Rig rig;
    push_unclocked(rig.store, kThisBoot);
    rig.queue.set_clock(boot_clock(true, true));
    TEST_ASSERT_EQUAL(ESP_OK, rig.queue.drain(16, kAckTimeoutMs));
    const attendance_record_t wire = sent(rig.link);
    TEST_ASSERT_TRUE(wire.ts == kBootAtMs + kSinceBootMs);
    TEST_ASSERT_TRUE(wire.clock_unsynced);
}

TEST_CASE("an earlier boot's unclocked stamp, or one with no clock to wait for, goes as it is",
          "[svc_sync]")
{
    Rig rig;
    push_unclocked(rig.store, kThisBoot - 1);
    rig.queue.set_clock(boot_clock(true, true));
    TEST_ASSERT_EQUAL(ESP_OK, rig.queue.drain(16, kAckTimeoutMs));
    TEST_ASSERT_TRUE(sent(rig.link).ts == kSinceBootMs);

    push_unclocked(rig.store, kThisBoot);
    rig.queue.set_clock(boot_clock(false, false));
    TEST_ASSERT_EQUAL(ESP_OK, rig.queue.drain(16, kAckTimeoutMs));
    TEST_ASSERT_TRUE(sent(rig.link).ts == kSinceBootMs);
}

TEST_CASE("an unclocked stamp waits at the cursor until a clock can place it", "[svc_sync]")
{
    Rig rig;
    push_unclocked(rig.store, kThisBoot);
    rig.store.push(((uint64_t)kThisBoot << 32) | 2u, 43, STORAGE_ATTEND_FLAG_NO_NTP);
    rig.queue.set_clock(boot_clock(false, true));
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, rig.queue.drain(16, kAckTimeoutMs));
    TEST_ASSERT_EQUAL(0, rig.link.sends);
    TEST_ASSERT_EQUAL(0, rig.store.at());
    TEST_ASSERT_TRUE(rig.queue.pending());

    rig.queue.set_clock(boot_clock(true, true));
    TEST_ASSERT_EQUAL(ESP_OK, rig.queue.drain(16, kAckTimeoutMs));
    TEST_ASSERT_EQUAL(2, rig.link.sends);
    TEST_ASSERT_EQUAL(2, rig.store.at());
}

TEST_CASE("an empty log drains to nothing and sends nothing", "[svc_sync]")
{
    Rig rig;
    TEST_ASSERT_EQUAL(ESP_OK, rig.queue.drain(16, kAckTimeoutMs));
    TEST_ASSERT_EQUAL(0, rig.link.sends);
    TEST_ASSERT_FALSE(rig.queue.pending());
    TEST_ASSERT_EQUAL(0, rig.store.set_calls);
}

TEST_CASE("one acked record moves the cursor exactly one slot", "[svc_sync]")
{
    Rig rig;
    rig.store.push(1, 42, STORAGE_ATTEND_FLAG_DOOR);
    TEST_ASSERT_EQUAL(ESP_OK, rig.queue.drain(16, kAckTimeoutMs));
    TEST_ASSERT_EQUAL(1, rig.link.sends);
    TEST_ASSERT_EQUAL(1, rig.store.at());
    TEST_ASSERT_EQUAL(1, rig.queue.stats().acked);
    TEST_ASSERT_FALSE(rig.queue.pending());
}

// The payload is the contract's own encoder, so a field that drifts from the
// schema fails here rather than at the backend.
TEST_CASE("the payload carries every field the schema requires", "[svc_sync]")
{
    Rig rig;
    rig.store.push(0x100000007ull, 42, STORAGE_ATTEND_FLAG_DOOR | STORAGE_ATTEND_FLAG_OFFLINE);
    TEST_ASSERT_EQUAL(ESP_OK, rig.queue.drain(1, kAckTimeoutMs));
    printf("payload: %s\n", rig.link.last);

    cJSON *root = cJSON_Parse(rig.link.last);
    TEST_ASSERT_NOT_NULL(root);
    attendance_record_t wire = {};
    const bool parsed = attendance_record_from_json(root, &wire);
    cJSON_Delete(root);
    TEST_ASSERT_TRUE(parsed);

    TEST_ASSERT_EQUAL_STRING(kDeviceId, wire.device_id);
    TEST_ASSERT_EQUAL_STRING("4294967303", wire.local_id);
    TEST_ASSERT_EQUAL_UINT32(42, wire.employee_id);
    TEST_ASSERT_EQUAL(ATTENDANCE_RECORD_DIRECTION_IN, wire.direction);
    TEST_ASSERT_FLOAT_WITHIN(0.005f, 0.83f, wire.match_score);
    TEST_ASSERT_FLOAT_WITHIN(0.005f, 0.91f, wire.liveness_score);
    TEST_ASSERT_TRUE(wire.door_opened);
    TEST_ASSERT_TRUE(wire.captured_offline);
    TEST_ASSERT_FALSE(wire.clock_unsynced);
}

TEST_CASE("a broker that is down leaves the cursor where it stands", "[svc_sync]")
{
    Rig rig;
    rig.store.push(1, 42, 0);
    rig.link.online = false;
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, rig.queue.drain(16, kAckTimeoutMs));
    TEST_ASSERT_EQUAL(0, rig.link.sends);
    TEST_ASSERT_EQUAL(0, rig.store.at());
    TEST_ASSERT_TRUE(rig.queue.pending());
}

TEST_CASE("a publish that never gets acked leaves the cursor where it stands", "[svc_sync]")
{
    Rig rig;
    rig.store.push(1, 42, 0);
    rig.link.answer = ESP_ERR_TIMEOUT;
    TEST_ASSERT_EQUAL(ESP_ERR_TIMEOUT, rig.queue.drain(16, kAckTimeoutMs));
    TEST_ASSERT_EQUAL(1, rig.link.sends);
    TEST_ASSERT_EQUAL(0, rig.store.at());
    TEST_ASSERT_EQUAL(0, rig.store.set_calls);
    TEST_ASSERT_EQUAL(0, rig.queue.stats().acked);
}

// At-least-once by design: the broker holds the record but the cursor write
// failed, so the next drain resends rather than dropping it (KEHOACH 6.2.6).
TEST_CASE("a record acked with the cursor unwritten is sent again", "[svc_sync]")
{
    Rig rig;
    rig.store.push(1, 42, 0);
    rig.store.set_answer = ESP_ERR_TIMEOUT;
    TEST_ASSERT_EQUAL(ESP_ERR_TIMEOUT, rig.queue.drain(16, kAckTimeoutMs));
    TEST_ASSERT_EQUAL(1, rig.link.sends);
    TEST_ASSERT_EQUAL(1, rig.queue.stats().orphans);
    TEST_ASSERT_EQUAL(0, rig.store.at());

    rig.store.set_answer = ESP_OK;
    TEST_ASSERT_EQUAL(ESP_OK, rig.queue.drain(16, kAckTimeoutMs));
    TEST_ASSERT_EQUAL(2, rig.link.sends);
    TEST_ASSERT_EQUAL(1, rig.store.at());
}

TEST_CASE("a batch stops at its size and says there is more", "[svc_sync]")
{
    Rig rig;
    for (uint64_t i = 1; i <= 5; ++i) {
        rig.store.push(i, 42, 0);
    }
    TEST_ASSERT_EQUAL(ESP_ERR_NOT_FINISHED, rig.queue.drain(2, kAckTimeoutMs));
    TEST_ASSERT_EQUAL(2, rig.store.at());
    TEST_ASSERT_TRUE(rig.queue.pending());
    TEST_ASSERT_EQUAL(ESP_ERR_NOT_FINISHED, rig.queue.drain(2, kAckTimeoutMs));
    TEST_ASSERT_EQUAL(4, rig.store.at());
    TEST_ASSERT_EQUAL(ESP_OK, rig.queue.drain(2, kAckTimeoutMs));
    TEST_ASSERT_EQUAL(5, rig.store.at());
    TEST_ASSERT_FALSE(rig.queue.pending());
}

TEST_CASE("a send that fails halfway keeps what it sent and holds the rest", "[svc_sync]")
{
    Rig rig;
    for (uint64_t i = 1; i <= 4; ++i) {
        rig.store.push(i, 42, 0);
    }
    TEST_ASSERT_EQUAL(ESP_ERR_NOT_FINISHED, rig.queue.drain(2, kAckTimeoutMs));
    rig.link.answer = ESP_ERR_TIMEOUT;
    TEST_ASSERT_EQUAL(ESP_ERR_TIMEOUT, rig.queue.drain(8, kAckTimeoutMs));
    TEST_ASSERT_EQUAL(2, rig.store.at());
    TEST_ASSERT_EQUAL(2, rig.queue.stats().acked);
    TEST_ASSERT_TRUE(rig.queue.pending());
}

// The acceptance of E10-T6: an hour off the network must cost nothing.
TEST_CASE("an outage with records piling up loses none of them and keeps order",
          "[svc_sync]")
{
    Rig rig;
    rig.link.online = false;
    for (uint64_t i = 1; i <= 30; ++i) {
        rig.store.push(i, (uint32_t)i, 0);
        TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, rig.queue.drain(16, kAckTimeoutMs));
    }
    TEST_ASSERT_EQUAL(0, rig.link.sends);
    TEST_ASSERT_EQUAL(0, rig.store.at());

    rig.link.online = true;
    TEST_ASSERT_EQUAL(ESP_ERR_NOT_FINISHED, rig.queue.drain(16, kAckTimeoutMs));
    TEST_ASSERT_EQUAL(ESP_OK, rig.queue.drain(16, kAckTimeoutMs));
    TEST_ASSERT_EQUAL(30, rig.link.sends);
    TEST_ASSERT_EQUAL(30, rig.store.at());
    TEST_ASSERT_EQUAL(30, rig.queue.stats().acked);
    TEST_ASSERT_FALSE(rig.queue.pending());

    cJSON *root = cJSON_Parse(rig.link.last);
    TEST_ASSERT_NOT_NULL(root);
    attendance_record_t wire = {};
    TEST_ASSERT_TRUE(attendance_record_from_json(root, &wire));
    cJSON_Delete(root);
    TEST_ASSERT_EQUAL_STRING("30", wire.local_id);
}

TEST_CASE("a queue restarted at a cursor resumes rather than starting over", "[svc_sync]")
{
    Rig rig;
    for (uint64_t i = 1; i <= 3; ++i) {
        rig.store.push(i, 42, 0);
    }
    TEST_ASSERT_EQUAL(ESP_ERR_NOT_FINISHED, rig.queue.drain(1, kAckTimeoutMs));

    uplink::UplinkQueue again(rig.store, rig.link);
    TEST_ASSERT_EQUAL(ESP_OK, again.init(kDeviceId));
    TEST_ASSERT_TRUE(again.pending());
    TEST_ASSERT_EQUAL(ESP_OK, again.drain(16, kAckTimeoutMs));
    TEST_ASSERT_EQUAL(3, rig.link.sends);
    TEST_ASSERT_EQUAL(2, again.stats().acked);
}

TEST_CASE("a batch of zero is refused rather than looping forever", "[svc_sync]")
{
    Rig rig;
    rig.store.push(1, 42, 0);
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, rig.queue.drain(0, kAckTimeoutMs));
    TEST_ASSERT_EQUAL(0, rig.link.sends);
}

extern "C" void app_main(void)
{
    usb_serial_jtag_driver_config_t console = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    if (usb_serial_jtag_driver_install(&console) == ESP_OK) {
        usb_serial_jtag_vfs_use_driver();
    }
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
