#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "storage_format.h"
#include "sys_storage.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "app_config.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "unity.h"

#define FACES_PATH STORAGE_FACES_PATH
#define APPEND_PATH "/lfs/tmp/append.bin"
#define SCRATCH_PATH "/lfs/tmp/scratch.bin"
#define RECORDS 16
#define CUT_LOOP_REPORT 50
#define CUT_LOOP_KEY "cut_loop"
#define CUT_STATE_KEY "cut_state"
#define CUT_COUNT_KEY "cut_count"
#define LOG_CUT_KEY "log_cut"
#define LOG_SEQ_KEY "log_seq"
#define LOG_BOOT_KEY "log_boot"
#define BOOT_WINDOW_MS 60000
#define BOOT_HOLD_MS 2000
#define BOOT_POLL_MS 50
#define FACES_LOOP_NAME "write faces.bin forever so power can be cut mid-write"
#define LOG_LOOP_NAME "append records forever so power can be cut mid-append"
// A 4 MB partition holds sixteen 256 KB files, so the log can reach no further.
#define LOG_FILES 16
#define LOG_HEADER_BYTES sizeof(storage_file_header_t)
#define LOG_RECORD_BYTES sizeof(storage_attend_record_t)
#define LOG_FILL_RECORDS ((STORAGE_ATTEND_ROTATE_BYTES - LOG_HEADER_BYTES) / LOG_RECORD_BYTES)
#define LOG_FILL_BLOCK 20
#define PATH_LEN 32

static void fill_header(storage_file_header_t *header, uint32_t magic, uint32_t count)
{
    memset(header, 0, sizeof(*header));
    header->magic = magic;
    header->format_ver = STORAGE_FACES_VER;
    header->record_size = sizeof(storage_face_record_t);
    header->record_count = count;
    header->crc32 = sys_storage_crc32(header, offsetof(storage_file_header_t, crc32));
}


static bool exists(const char *path)
{
    // access() is not among the calls esp_littlefs registers with the VFS, so
    // it fails for every path; stat() is.
    struct stat st;
    return stat(path, &st) == 0;
}

static long size_of(const char *path)
{
    struct stat st;
    return stat(path, &st) == 0 ? (long)st.st_size : -1;
}

static void log_path_of(uint32_t index, char *out, size_t cap)
{
    snprintf(out, cap, STORAGE_ATTEND_FMT, (unsigned)index);
}

// The rotation cases leave the log under a different name on every run.
static uint32_t newest_log_index(void)
{
    char path[PATH_LEN];
    uint32_t newest = 0;
    for (uint32_t index = 0; index < LOG_FILES; ++index) {
        log_path_of(index, path, sizeof(path));
        if (exists(path)) {
            newest = index;
        }
    }
    return newest;
}

static void wipe_log(void)
{
    char path[PATH_LEN];
    for (uint32_t index = 0; index < LOG_FILES; ++index) {
        log_path_of(index, path, sizeof(path));
        unlink(path);
    }
    unlink(STORAGE_CURSOR_PATH);
    unlink(STORAGE_CURSOR_PATH ".bak");
    unlink(STORAGE_CURSOR_PATH ".tmp");
}

static void fill_record(storage_attend_record_t *record, uint32_t seq)
{
    memset(record, 0, sizeof(*record));
    record->magic = STORAGE_ATTEND_REC_MAGIC;
    record->local_id = ((uint64_t)sys_storage_boot_count() << 32) | seq;
    record->employee_id = 4000u + seq % 100u;
    record->ts_ms = (int64_t)seq * 1000;
    record->crc32 = sys_storage_crc32(record, offsetof(storage_attend_record_t, crc32));
}

static bool record_holds(const storage_attend_record_t *record)
{
    const uint32_t crc = sys_storage_crc32(record, offsetof(storage_attend_record_t, crc32));
    return record->magic == STORAGE_ATTEND_REC_MAGIC && record->crc32 == crc;
}

TEST_CASE("init mounts once and refuses a second time", "[sys_storage]")
{
    const esp_err_t up = sys_storage_init();
    TEST_ASSERT_TRUE(up == ESP_OK || up == ESP_ERR_INVALID_STATE);
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, sys_storage_init());
    TEST_ASSERT_GREATER_THAN(0, sys_storage_boot_count());
}

TEST_CASE("whatever the last power-up left behind still reads back checked", "[sys_storage]")
{
    // Runs first: the cases below rewrite faces.bin, and this one has to see
    // the file exactly as a power cut in the [manual] loop left it.
    uint32_t loop_ran = 0;
    sys_storage_get_u32(STORAGE_NS_SYS, CUT_LOOP_KEY, &loop_ran);
    const bool primary = exists(FACES_PATH);
    const bool backup = exists(FACES_PATH ".bak");
    const bool temp = exists(FACES_PATH ".tmp");
    char newest[PATH_LEN];
    log_path_of(newest_log_index(), newest, sizeof(newest));
    // The log keeps at least one file through every case here, so that name
    // going missing means a wipe, not two renames losing one file.
    const bool other = exists(newest);
    printf("after the last power-up: loop marker %lu, primary %d, backup %d, tmp %d, log %d\n",
           (unsigned long)loop_ran, primary, backup, temp, other);
    // The board boots on its own when power returns, so the reading is kept
    // in nvs for whoever attaches a console afterwards.
    if (loop_ran) {
        sys_storage_set_u32(STORAGE_NS_SYS, CUT_STATE_KEY, (uint32_t)primary | (uint32_t)backup << 1 |
                                               (uint32_t)temp << 2 | (uint32_t)other << 3);
    }
    uint32_t stored = 0;
    if (sys_storage_get_u32(STORAGE_NS_SYS, CUT_STATE_KEY, &stored) == ESP_OK) {
        printf("stored post-cut snapshot: primary %lu, backup %lu, tmp %lu, log %lu\n",
               (unsigned long)(stored & 1), (unsigned long)(stored >> 1 & 1),
               (unsigned long)(stored >> 2 & 1), (unsigned long)(stored >> 3 & 1));
    }
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_set_u32(STORAGE_NS_SYS, CUT_LOOP_KEY, 0));
    if (!primary && !backup) {
        TEST_ASSERT_EQUAL_MESSAGE(0, loop_ran, "the loop ran and the cut lost BOTH copies");
        TEST_IGNORE_MESSAGE("no faces.bin yet: run the power-cut loop, cut power, boot again");
    }
    storage_file_header_t got;
    size_t len = 0;
    bool used_backup = false;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_read_checked(FACES_PATH, STORAGE_FACES_MAGIC, &got,
                                                       sizeof(got), &len, &used_backup));
    printf("faces.bin from the last power-up: record_count %lu, %s\n",
           (unsigned long)got.record_count, used_backup ? "served from backup" : "primary intact");
    if (loop_ran) {
        sys_storage_set_u32(STORAGE_NS_SYS, CUT_COUNT_KEY, got.record_count | (uint32_t)used_backup << 31);
    }
    uint32_t stored_count = 0;
    if (sys_storage_get_u32(STORAGE_NS_SYS, CUT_COUNT_KEY, &stored_count) == ESP_OK) {
        printf("stored post-cut record_count %lu, %s\n", (unsigned long)(stored_count & 0x7FFFFFFF),
               (stored_count >> 31) ? "served from backup" : "primary intact");
    }
}

// Reads the log the way a fresh firmware would: sequentially, at the 48 B grid,
// counting only records this run of the loop wrote and passed their checksum.
static void scan_log(uint32_t boot, uint32_t *count, uint32_t *highest)
{
    *count = 0;
    *highest = 0;
    char path[PATH_LEN];
    storage_attend_record_t record;
    for (uint32_t index = 0; index < LOG_FILES; ++index) {
        log_path_of(index, path, sizeof(path));
        FILE *file = fopen(path, "rb");
        if (file == NULL) {
            continue;
        }
        fseek(file, (long)LOG_HEADER_BYTES, SEEK_SET);
        while (fread(&record, 1, sizeof(record), file) == sizeof(record)) {
            if (!record_holds(&record) || (uint32_t)(record.local_id >> 32) != boot) {
                continue;
            }
            const uint32_t seq = (uint32_t)record.local_id;
            ++*count;
            if (seq > *highest) {
                *highest = seq;
            }
        }
        fclose(file);
    }
}

TEST_CASE("the log kept every record the last power-up confirmed", "[sys_storage]")
{
    // Runs early: the log cases below rewrite these files, and this one has to
    // see them exactly as the power cut left them.
    const esp_err_t up = sys_storage_init();
    TEST_ASSERT_TRUE(up == ESP_OK || up == ESP_ERR_INVALID_STATE);
    uint32_t loop_ran = 0;
    uint32_t confirmed = 0;
    uint32_t loop_boot = 0;
    sys_storage_get_u32(STORAGE_NS_SYS, LOG_CUT_KEY, &loop_ran);
    sys_storage_get_u32(STORAGE_NS_SYS, LOG_SEQ_KEY, &confirmed);
    sys_storage_get_u32(STORAGE_NS_SYS, LOG_BOOT_KEY, &loop_boot);
    uint32_t count = 0;
    uint32_t highest = 0;
    scan_log(loop_boot, &count, &highest);
    printf("loop marker %lu: boot %lu confirmed %lu records, the log holds %lu, highest seq %lu\n",
           (unsigned long)loop_ran, (unsigned long)loop_boot, (unsigned long)confirmed,
           (unsigned long)count, (unsigned long)highest);
    if (!loop_ran) {
        TEST_IGNORE_MESSAGE("no cut since the last check: tap BOOT, cut power, boot again");
    }
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_set_u32(STORAGE_NS_SYS, LOG_CUT_KEY, 0));
    TEST_ASSERT_GREATER_OR_EQUAL_UINT32(confirmed, count);
    // Sequence numbers start at one, so a gap anywhere puts the count below the
    // highest number seen even when nothing looks torn.
    TEST_ASSERT_EQUAL_UINT32(highest, count);
}

TEST_CASE("a setting survives the round trip through nvs", "[sys_storage]")
{
    const uint32_t written = 0xA5A50042u;
    uint32_t read_back = 0;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_set_u32(STORAGE_NS_SYS, "probe", written));
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_get_u32(STORAGE_NS_SYS, "probe", &read_back));
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
    unlink(APPEND_PATH);
    storage_attend_record_t *written = s_written;
    for (int i = 0; i < RECORDS; ++i) {
        memset(&written[i], 0, sizeof(written[i]));
        written[i].magic = STORAGE_ATTEND_REC_MAGIC;
        written[i].local_id = ((uint64_t)sys_storage_boot_count() << 32) | (uint32_t)i;
        written[i].employee_id = 1000u + i;
        written[i].crc32 = sys_storage_crc32(&written[i], offsetof(storage_attend_record_t, crc32));
        TEST_ASSERT_EQUAL(ESP_OK, sys_storage_append(APPEND_PATH, &written[i], sizeof(written[i])));
    }

    storage_attend_record_t *read_back = s_read_back;
    size_t len = 0;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_read(APPEND_PATH, read_back, sizeof(s_read_back), &len));
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
                      sys_storage_read(APPEND_PATH, narrow, sizeof(narrow), &len));
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

TEST_CASE("the first record creates the log with its own header", "[sys_storage]")
{
    wipe_log();
    storage_attend_record_t record;
    fill_record(&record, 1);
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_append(&record));

    char path[PATH_LEN];
    log_path_of(newest_log_index(), path, sizeof(path));
    struct {
        storage_file_header_t header;
        storage_attend_record_t record;
    } opened;
    size_t len = 0;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_read(path, &opened, sizeof(opened), &len));
    printf("%s opened with %u B header, record_size %u, %u B in all\n", path,
           (unsigned)LOG_HEADER_BYTES, opened.header.record_size, (unsigned)len);
    TEST_ASSERT_EQUAL_UINT(sizeof(opened), len);
    TEST_ASSERT_EQUAL_HEX32(STORAGE_ATTEND_MAGIC, opened.header.magic);
    TEST_ASSERT_EQUAL_UINT16(STORAGE_ATTEND_VER, opened.header.format_ver);
    TEST_ASSERT_EQUAL_UINT16(LOG_RECORD_BYTES, opened.header.record_size);
    TEST_ASSERT_EQUAL_UINT32(
        sys_storage_crc32(&opened.header, offsetof(storage_file_header_t, crc32)),
        opened.header.crc32);
    TEST_ASSERT_EQUAL_MEMORY(&record, &opened.record, sizeof(record));
}

TEST_CASE("the cursor walks the records and stops at the end", "[sys_storage]")
{
    wipe_log();
    storage_attend_record_t written;
    for (uint32_t seq = 1; seq <= 3; ++seq) {
        fill_record(&written, seq);
        TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_append(&written));
    }
    storage_cursor_t at;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_cursor_get(&at));
    TEST_ASSERT_EQUAL_UINT32(LOG_HEADER_BYTES, at.offset);

    storage_attend_record_t got;
    storage_cursor_t next;
    for (uint32_t seq = 1; seq <= 3; ++seq) {
        TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_read(&at, &got, &next));
        TEST_ASSERT_EQUAL_UINT32(seq, (uint32_t)got.local_id);
        TEST_ASSERT_EQUAL_UINT32(at.offset + LOG_RECORD_BYTES, next.offset);
        at = next;
    }
    printf("three records walked, the cursor rests at file %u offset %lu\n", at.file_index,
           (unsigned long)at.offset);
    TEST_ASSERT_EQUAL(ESP_ERR_NOT_FOUND, sys_storage_attend_read(&at, &got, &next));
}

TEST_CASE("a tail left by a cut mid-append is cut off, not read as a record", "[sys_storage]")
{
    wipe_log();
    storage_attend_record_t record;
    fill_record(&record, 1);
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_append(&record));
    char path[PATH_LEN];
    log_path_of(newest_log_index(), path, sizeof(path));
    const long whole = size_of(path);

    // What a cut in the middle of one fwrite leaves behind: part of a record.
    const size_t torn_bytes = LOG_RECORD_BYTES / 3;
    FILE *torn = fopen(path, "ab");
    TEST_ASSERT_NOT_NULL(torn);
    TEST_ASSERT_EQUAL_UINT(torn_bytes, fwrite(&record, 1, torn_bytes, torn));
    fclose(torn);
    TEST_ASSERT_EQUAL(whole + (long)torn_bytes, size_of(path));

    fill_record(&record, 2);
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_append(&record));
    printf("%s carried a %u B tail, back on the grid at %ld B\n", path, (unsigned)torn_bytes,
           size_of(path));
    TEST_ASSERT_EQUAL(whole + (long)LOG_RECORD_BYTES, size_of(path));

    storage_cursor_t at;
    storage_cursor_t next;
    storage_attend_record_t got;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_cursor_get(&at));
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_read(&at, &got, &next));
    TEST_ASSERT_EQUAL_UINT32(1, (uint32_t)got.local_id);
    at = next;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_read(&at, &got, &next));
    TEST_ASSERT_EQUAL_UINT32(2, (uint32_t)got.local_id);
}

TEST_CASE("the cursor keeps its place across a torn write and refuses a bad offset",
          "[sys_storage]")
{
    storage_cursor_t first;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_cursor_get(&first));
    first.offset = LOG_HEADER_BYTES + LOG_RECORD_BYTES;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_cursor_set(&first));
    storage_cursor_t second = first;
    second.offset += LOG_RECORD_BYTES;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_cursor_set(&second));

    storage_cursor_t stored;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_cursor_get(&stored));
    TEST_ASSERT_EQUAL_UINT32(second.offset, stored.offset);
    TEST_ASSERT_EQUAL_UINT16(second.file_index, stored.file_index);

    FILE *torn = fopen(STORAGE_CURSOR_PATH, "wb");
    TEST_ASSERT_NOT_NULL(torn);
    fwrite("half", 1, 4, torn);
    fclose(torn);
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_cursor_get(&stored));
    printf("a torn cursor.bin answered from its backup: offset %lu\n",
           (unsigned long)stored.offset);
    TEST_ASSERT_EQUAL_UINT32(first.offset, stored.offset);

    stored.offset = LOG_HEADER_BYTES + 1;
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, sys_storage_attend_cursor_set(&stored));
}

// Bulk-written rather than appended one at a time: 5460 syncs would spend a
// minute and a half of the suite to reach the same bytes.
static storage_attend_record_t s_fill[LOG_FILL_BLOCK];

TEST_CASE("the log rotates when the next record no longer fits", "[sys_storage]")
{
    wipe_log();
    storage_attend_record_t record;
    fill_record(&record, 1);
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_append(&record));
    const uint32_t index = newest_log_index();
    char path[PATH_LEN];
    char rotated[PATH_LEN];
    log_path_of(index, path, sizeof(path));
    log_path_of(index + 1, rotated, sizeof(rotated));

    FILE *file = fopen(path, "ab");
    TEST_ASSERT_NOT_NULL(file);
    for (uint32_t seq = 2; seq <= LOG_FILL_RECORDS; seq += LOG_FILL_BLOCK) {
        const uint32_t left = (uint32_t)LOG_FILL_RECORDS - seq + 1;
        const uint32_t count = left < LOG_FILL_BLOCK ? left : LOG_FILL_BLOCK;
        for (uint32_t i = 0; i < count; ++i) {
            fill_record(&s_fill[i], seq + i);
        }
        TEST_ASSERT_EQUAL_UINT(count, fwrite(s_fill, LOG_RECORD_BYTES, count, file));
    }
    fflush(file);
    fsync(fileno(file));
    fclose(file);
    const long filled = size_of(path);
    printf("%s filled to %ld B of %u, %u records\n", path, filled,
           (unsigned)STORAGE_ATTEND_ROTATE_BYTES, (unsigned)LOG_FILL_RECORDS);
    TEST_ASSERT_TRUE(filled + (long)LOG_RECORD_BYTES > (long)STORAGE_ATTEND_ROTATE_BYTES);
    TEST_ASSERT_FALSE(exists(rotated));

    fill_record(&record, (uint32_t)LOG_FILL_RECORDS + 1);
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_append(&record));
    TEST_ASSERT_EQUAL(filled, size_of(path));
    TEST_ASSERT_EQUAL(LOG_HEADER_BYTES + LOG_RECORD_BYTES, size_of(rotated));
}

TEST_CASE("a file the cursor has left behind is dropped", "[sys_storage]")
{
    const uint32_t newest = newest_log_index();
    TEST_ASSERT_GREATER_THAN_UINT32_MESSAGE(0, newest, "the rotation case has to run first");
    char behind[PATH_LEN];
    char kept[PATH_LEN];
    log_path_of(newest - 1, behind, sizeof(behind));
    log_path_of(newest, kept, sizeof(kept));
    TEST_ASSERT_TRUE(exists(behind));

    storage_cursor_t moved;
    memset(&moved, 0, sizeof(moved));
    moved.file_index = (uint16_t)newest;
    moved.offset = LOG_HEADER_BYTES;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_cursor_set(&moved));
    printf("cursor at file %u: %s %s, %s %s\n", (unsigned)newest, behind,
           exists(behind) ? "kept" : "dropped", kept, exists(kept) ? "kept" : "dropped");
    TEST_ASSERT_FALSE(exists(behind));
    TEST_ASSERT_TRUE(exists(kept));
}

TEST_CASE("append records forever so power can be cut mid-append", "[sys_storage][manual]")
{
    // Picked by name from app_main, so it cannot lean on the cases above.
    const esp_err_t up = sys_storage_init();
    TEST_ASSERT_TRUE(up == ESP_OK || up == ESP_ERR_INVALID_STATE);
    uint32_t marker = 0;
    sys_storage_get_u32(STORAGE_NS_SYS, LOG_CUT_KEY, &marker);
    if (marker) {
        TEST_IGNORE_MESSAGE("a cut happened since the last check: flash the normal suite first");
    }
    wipe_log();
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_set_u32(STORAGE_NS_SYS, LOG_BOOT_KEY,
                                                  sys_storage_boot_count()));
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_set_u32(STORAGE_NS_SYS, LOG_SEQ_KEY, 0));
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_set_u32(STORAGE_NS_SYS, LOG_CUT_KEY, 1));
    storage_attend_record_t record;
    for (uint32_t seq = 1;; ++seq) {
        fill_record(&record, seq);
        TEST_ASSERT_EQUAL(ESP_OK, sys_storage_attend_append(&record));
        // The count reaches nvs only every so often, so it stays a floor on
        // what the log must hold rather than a second write per record.
        if (seq % CUT_LOOP_REPORT == 0) {
            TEST_ASSERT_EQUAL(ESP_OK, sys_storage_set_u32(STORAGE_NS_SYS, LOG_SEQ_KEY, seq));
            printf("record %lu confirmed, cut power whenever you like\n", (unsigned long)seq);
        }
    }
}

TEST_CASE("write faces.bin forever so power can be cut mid-write", "[sys_storage][manual]")
{
    // Picked from the menu on its own, so it cannot lean on the init case.
    const esp_err_t up = sys_storage_init();
    TEST_ASSERT_TRUE(up == ESP_OK || up == ESP_ERR_INVALID_STATE);
    uint32_t marker = 0;
    sys_storage_get_u32(STORAGE_NS_SYS, CUT_LOOP_KEY, &marker);
    // Looping again after a cut would overwrite the very file the cut left.
    if (marker) {
        TEST_IGNORE_MESSAGE("a cut happened since the last check: flash the normal suite first");
    }
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_set_u32(STORAGE_NS_SYS, CUT_LOOP_KEY, 1));
    storage_file_header_t header;
    for (uint32_t n = 1;; ++n) {
        fill_header(&header, STORAGE_FACES_MAGIC, n);
        TEST_ASSERT_EQUAL(ESP_OK, sys_storage_write_atomic(FACES_PATH, &header, sizeof(header)));
        if (n % CUT_LOOP_REPORT == 0) {
            printf("write %lu done, cut power whenever you like\n", (unsigned long)n);
        }
    }
}

TEST_CASE("two namespaces hold the same key without meeting", "[sys_storage]")
{
    const char *key = "same_key";
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_set_u32(STORAGE_NS_UI, key, 11));
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_set_u32(STORAGE_NS_VISION, key, 22));
    uint32_t from_ui = 0, from_vision = 0;
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_get_u32(STORAGE_NS_UI, key, &from_ui));
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_get_u32(STORAGE_NS_VISION, key, &from_vision));
    printf("ui %u, vision %u for one key name\n", (unsigned)from_ui, (unsigned)from_vision);
    TEST_ASSERT_EQUAL(11, from_ui);
    TEST_ASSERT_EQUAL(22, from_vision);
}

TEST_CASE("a string setting comes back whole and a short buffer is refused", "[sys_storage]")
{
    const char *host = "pool.ntp.org";
    TEST_ASSERT_EQUAL(ESP_OK, sys_storage_set_str(STORAGE_NS_DEVICE, "sntp_host", host));
    char read_back[32] = { 0 };
    TEST_ASSERT_EQUAL(ESP_OK,
                      sys_storage_get_str(STORAGE_NS_DEVICE, "sntp_host", read_back,
                                          sizeof(read_back)));
    printf("sntp_host reads %s\n", read_back);
    TEST_ASSERT_EQUAL_STRING(host, read_back);
    char tiny[4] = { 0 };
    TEST_ASSERT_NOT_EQUAL(ESP_OK,
                          sys_storage_get_str(STORAGE_NS_DEVICE, "sntp_host", tiny, sizeof(tiny)));
}

void app_main(void)
{
    // The mount-failed-so-format path in esp_littlefs logs only at verbose,
    // and it is the path the power-cut cases exist to catch.
    esp_log_level_set("esp_littlefs", ESP_LOG_VERBOSE);
    const gpio_config_t boot_button = {
        .pin_bit_mask = 1ULL << APP_FACTORY_RESET_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&boot_button));
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
    // GPIO0 low at reset is the download-mode strap, so the button is read in
    // a window once the suite is done: press it then to start the power-cut loop.
    printf("within %d s: tap BOOT for the attendance log loop, hold %d s for faces.bin\n",
           BOOT_WINDOW_MS / 1000, BOOT_HOLD_MS / 1000);
    bool pressed = false;
    for (int waited = 0; waited < BOOT_WINDOW_MS && !pressed; waited += BOOT_POLL_MS) {
        vTaskDelay(pdMS_TO_TICKS(BOOT_POLL_MS));
        pressed = gpio_get_level(APP_FACTORY_RESET_GPIO) == 0;
    }
    if (pressed) {
        bool held = true;
        for (int waited = 0; waited < BOOT_HOLD_MS && held; waited += BOOT_POLL_MS) {
            vTaskDelay(pdMS_TO_TICKS(BOOT_POLL_MS));
            held = gpio_get_level(APP_FACTORY_RESET_GPIO) == 0;
        }
        printf("starting the %s loop\n", held ? "faces.bin" : "attendance log");
        UNITY_BEGIN();
        unity_run_test_by_name(held ? FACES_LOOP_NAME : LOG_LOOP_NAME);
        UNITY_END();
    }
}
