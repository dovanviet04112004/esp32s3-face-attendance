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
#define LOG_PATH "/lfs/log/attend.000"
#define SCRATCH_PATH "/lfs/tmp/scratch.bin"
#define RECORDS 16
#define CUT_LOOP_REPORT 50
#define CUT_LOOP_KEY "cut_loop"
#define CUT_STATE_KEY "cut_state"
#define CUT_COUNT_KEY "cut_count"
#define BOOT_WINDOW_MS 60000
#define BOOT_POLL_MS 50

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
    const bool other = exists(LOG_PATH);
    // attend.000 is never touched by the loop: gone too means a wipe of the
    // whole filesystem, not two renames losing one file.
    printf("after the last power-up: loop marker %lu, primary %d, backup %d, tmp %d, attend.000 %d\n",
           (unsigned long)loop_ran, primary, backup, temp, other);
    // The board boots on its own when power returns, so the reading is kept
    // in nvs for whoever attaches a console afterwards.
    if (loop_ran) {
        sys_storage_set_u32(STORAGE_NS_SYS, CUT_STATE_KEY, (uint32_t)primary | (uint32_t)backup << 1 |
                                               (uint32_t)temp << 2 | (uint32_t)other << 3);
    }
    uint32_t stored = 0;
    if (sys_storage_get_u32(STORAGE_NS_SYS, CUT_STATE_KEY, &stored) == ESP_OK) {
        printf("stored post-cut snapshot: primary %lu, backup %lu, tmp %lu, attend.000 %lu\n",
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
    printf("press BOOT within %d s to start the power-cut loop\n", BOOT_WINDOW_MS / 1000);
    bool pressed = false;
    for (int waited = 0; waited < BOOT_WINDOW_MS && !pressed; waited += BOOT_POLL_MS) {
        vTaskDelay(pdMS_TO_TICKS(BOOT_POLL_MS));
        pressed = gpio_get_level(APP_FACTORY_RESET_GPIO) == 0;
    }
    if (pressed) {
        printf("BOOT held: starting the power-cut loop\n");
        UNITY_BEGIN();
        unity_run_tests_by_tag("[manual]", false);
        UNITY_END();
    }
}
