#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include "storage_format.h"
#include "sys_storage.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "unity.h"

#define FACES_PATH "/lfs/db/faces.bin"
#define LOG_PATH "/lfs/log/attend.000"
#define SCRATCH_PATH "/lfs/tmp/scratch.bin"
#define RECORDS 16

static void fill_header(storage_file_header_t *header, uint32_t magic, uint32_t count)
{
    memset(header, 0, sizeof(*header));
    header->magic = magic;
    header->format_ver = STORAGE_FACES_VER;
    header->record_size = sizeof(storage_face_record_t);
    header->record_count = count;
    header->crc32 = sys_storage_crc32(header, offsetof(storage_file_header_t, crc32));
}

TEST_CASE("init mounts once and refuses a second time", "[sys_storage]")
{
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_init());
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, sys_storage_init());
    TEST_ASSERT_GREATER_THAN(0, sys_storage_boot_count());
}

TEST_CASE("a setting survives the round trip through nvs", "[sys_storage]")
{
    const uint32_t written = 0xA5A50042u;
    uint32_t read_back = 0;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_set_u32("probe", written));
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_get_u32("probe", &read_back));
    TEST_ASSERT_EQUAL_UINT32(written, read_back);
}

TEST_CASE("an atomic write replaces the file whole", "[sys_storage]")
{
    storage_file_header_t first, second;
    fill_header(&first, STORAGE_FACES_MAGIC, 1);
    fill_header(&second, STORAGE_FACES_MAGIC, 2);

    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_write_atomic(FACES_PATH, &first, sizeof(first)));
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_write_atomic(FACES_PATH, &second, sizeof(second)));

    storage_file_header_t got;
    size_t len = 0;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_read(FACES_PATH, &got, sizeof(got), &len));
    TEST_ASSERT_EQUAL_UINT(sizeof(got), len);
    TEST_ASSERT_EQUAL_UINT32(2, got.record_count);
}

TEST_CASE("the previous copy is kept, not overwritten in place", "[sys_storage]")
{
    // Two-phase writing is only worth its cost if the older copy is still
    // whole, so the fallback in the next case has something to reach for.
    storage_file_header_t previous;
    size_t len = 0;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_read(FACES_PATH ".bak", &previous, sizeof(previous),
                                               &len));
    TEST_ASSERT_EQUAL_UINT32(1, previous.record_count);
}

TEST_CASE("a torn primary is answered from the backup", "[sys_storage]")
{
    // What a power cut between the two renames leaves behind: a primary that
    // exists but does not pass its own checksum.
    FILE *torn = fopen(FACES_PATH, "wb");
    TEST_ASSERT_NOT_NULL(torn);
    const char rubbish[] = "half a header";
    fwrite(rubbish, 1, sizeof(rubbish), torn);
    fclose(torn);

    storage_file_header_t got;
    size_t len = 0;
    bool used_backup = false;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_read_checked(FACES_PATH, STORAGE_FACES_MAGIC, &got,
                                                       sizeof(got), &len, &used_backup));
    TEST_ASSERT_TRUE(used_backup);
    TEST_ASSERT_EQUAL_UINT32(1, got.record_count);
}

TEST_CASE("a leftover temporary does not disturb the real file", "[sys_storage]")
{
    storage_file_header_t good;
    fill_header(&good, STORAGE_FACES_MAGIC, 7);
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_write_atomic(FACES_PATH, &good, sizeof(good)));

    FILE *stale = fopen(FACES_PATH ".tmp", "wb");
    TEST_ASSERT_NOT_NULL(stale);
    fwrite("stale", 1, 5, stale);
    fclose(stale);

    storage_file_header_t got;
    size_t len = 0;
    bool used_backup = true;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_read_checked(FACES_PATH, STORAGE_FACES_MAGIC, &got,
                                                       sizeof(got), &len, &used_backup));
    TEST_ASSERT_FALSE(used_backup);
    TEST_ASSERT_EQUAL_UINT32(7, got.record_count);
    unlink(FACES_PATH ".tmp");
}

TEST_CASE("a wrong magic is refused even when the file reads cleanly", "[sys_storage]")
{
    storage_file_header_t got;
    size_t len = 0;
    bool used_backup = false;
    TEST_ASSERT_EQUAL(ESP_ERR_NOT_FOUND,
                      sys_storage_read_checked(FACES_PATH, STORAGE_ATTEND_MAGIC, &got, sizeof(got),
                                               &len, &used_backup));
}

// Sixteen records twice over do not fit beside LittleFS's own frames in the
// 3.5 KB the runner's task has, so the data lives outside the stack.
static storage_attend_record_t s_written[RECORDS];
static storage_attend_record_t s_read_back[RECORDS];

TEST_CASE("appended records land one after another and keep their bytes", "[sys_storage]")
{
    unlink(LOG_PATH);
    storage_attend_record_t *written = s_written;
    for (int i = 0; i < RECORDS; ++i) {
        memset(&written[i], 0, sizeof(written[i]));
        written[i].magic = STORAGE_ATTEND_REC_MAGIC;
        written[i].local_id = ((uint64_t)sys_storage_boot_count() << 32) | (uint32_t)i;
        written[i].employee_id = 1000u + i;
        written[i].crc32 = sys_storage_crc32(&written[i], offsetof(storage_attend_record_t, crc32));
        TEST_ASSERT_EQUAL(ESP_OK, sys_storage_append(LOG_PATH, &written[i], sizeof(written[i])));
    }

    storage_attend_record_t *read_back = s_read_back;
    size_t len = 0;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_read(LOG_PATH, read_back, sizeof(s_read_back), &len));
    TEST_ASSERT_EQUAL_UINT(sizeof(s_written), len);
    TEST_ASSERT_EQUAL_MEMORY(written, read_back, sizeof(s_written));
    printf("main task stack left after 16 appends: %u B of %u\n",
           (unsigned)uxTaskGetStackHighWaterMark(NULL) * sizeof(StackType_t),
           (unsigned)CONFIG_ESP_MAIN_TASK_STACK_SIZE);
    for (int i = 0; i < RECORDS; ++i) {
        const uint32_t crc =
            sys_storage_crc32(&read_back[i], offsetof(storage_attend_record_t, crc32));
        TEST_ASSERT_EQUAL_UINT32(crc, read_back[i].crc32);
    }
}

TEST_CASE("a buffer too small is refused rather than filled halfway", "[sys_storage]")
{
    uint8_t narrow[sizeof(storage_attend_record_t)];
    size_t len = 0;
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_SIZE,
                      sys_storage_read(LOG_PATH, narrow, sizeof(narrow), &len));
}

TEST_CASE("the scratch directory is emptied at boot", "[sys_storage]")
{
    // Enrol drops crops here and nothing reads them across a reboot, so a file
    // surviving init would grow the partition for the device's whole life.
    FILE *leftover = fopen(SCRATCH_PATH, "wb");
    TEST_ASSERT_NOT_NULL(leftover);
    fwrite("crop", 1, 4, leftover);
    fclose(leftover);

    uint8_t buf[8];
    size_t len = 0;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_read(SCRATCH_PATH, buf, sizeof(buf), &len));
    unlink(SCRATCH_PATH);
}

TEST_CASE("a packed models partition reads back, an unpacked one is refused", "[sys_storage]")
{
    const storage_models_header_t *header = NULL;
    const esp_err_t err = sys_storage_models_open(&header);
    const void *data = NULL;
    size_t size = 0;
    if (err != ESP_OK) {
        TEST_ASSERT_TRUE(err == ESP_ERR_INVALID_CRC || err == ESP_ERR_NOT_FOUND);
        TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, sys_storage_model_find("spoof", &data, &size, NULL));
        TEST_IGNORE_MESSAGE("models_0 carries no image, run ml/scripts/50_pack_and_flash.sh");
    }
    TEST_ASSERT_EQUAL_UINT32(STORAGE_MODELS_VER, header->format_ver);
    TEST_ASSERT_TRUE(header->count >= 1 && header->count <= STORAGE_MODEL_COUNT);
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_model_find("spoof", &data, &size, NULL));
    TEST_ASSERT_GREATER_THAN_UINT(0, size);
    // A flatbuffer carries its identifier at byte 4, so the packer's offset
    // arithmetic fails here rather than deep inside the interpreter.
    TEST_ASSERT_EQUAL_MEMORY("TFL3", (const uint8_t *)data + 4, 4);
}

void app_main(void)
{
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
}
