#include "sys_storage.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "app_err.h"
#include "esp_crc.h"
#include "esp_littlefs.h"
#include "esp_mac.h"
#include "esp_spiffs.h"
#include "esp_log.h"
#include "esp_partition.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "sys_storage";

#define MOUNT_POINT "/lfs"
#define SCRATCH_DIR MOUNT_POINT "/tmp"
#define PARTITION_STORAGE "storage"
#define PARTITION_MODELS "models_0"
#define PARTITION_ASSETS "assets"
#define ASSETS_POINT "/assets"
#define NVS_LEGACY_NAMESPACE "kiosk"
#define NVS_BOOT_COUNT "boot_count"
#define NVS_SERIAL "serial"
#define DEVICE_ID_PREFIX "kiosk-"
#define LOG_NAME_PREFIX "attend."
#define LOG_HEADER_BYTES sizeof(storage_file_header_t)
#define LOG_RECORD_BYTES sizeof(storage_attend_record_t)
#define NVS_SLOTS 7
#define LOCK_WAIT_MS 5000
#define PATH_MAX_LEN 64
// LittleFS allows a 255 byte name, and the compiler checks that the join fits.
#define SCRATCH_PATH_LEN (sizeof(SCRATCH_DIR) + 1 + 255)

typedef struct {
    const char *name;
    nvs_handle_t handle;
} nvs_slot_t;

static SemaphoreHandle_t s_lock;
static uint32_t s_log_index;
static uint32_t s_log_dropped_below;
static bool s_log_scanned;
static nvs_slot_t s_slots[NVS_SLOTS];
static uint32_t s_boot_count;
static bool s_ready;

static const storage_models_header_t *s_models;
static const uint8_t *s_models_base;
static size_t s_models_bytes;
static esp_partition_mmap_handle_t s_models_map;

static esp_err_t take(void)
{
    return xSemaphoreTake(s_lock, pdMS_TO_TICKS(LOCK_WAIT_MS)) == pdTRUE ? ESP_OK : ESP_ERR_TIMEOUT;
}

static void give(void)
{
    xSemaphoreGive(s_lock);
}

static void empty_scratch(void)
{
    DIR *dir = opendir(SCRATCH_DIR);
    if (dir == NULL) {
        mkdir(SCRATCH_DIR, 0777);
        return;
    }
    char path[SCRATCH_PATH_LEN];
    for (struct dirent *entry = readdir(dir); entry != NULL; entry = readdir(dir)) {
        snprintf(path, sizeof(path), "%s/%s", SCRATCH_DIR, entry->d_name);
        unlink(path);
    }
    closedir(dir);
}

// Read-only and its own mount: an asset is never written at run time, so it
// shares neither the lock nor the failure mode of the writable volume.
static void mount_assets(void)
{
    const esp_vfs_spiffs_conf_t cfg = {
        .base_path = ASSETS_POINT,
        .partition_label = PARTITION_ASSETS,
        .max_files = 2,
        .format_if_mount_failed = false,
    };
    const esp_err_t err = esp_vfs_spiffs_register(&cfg);
    size_t total = 0, used = 0;
    if (err == ESP_OK && esp_spiffs_info(PARTITION_ASSETS, &total, &used) == ESP_OK) {
        ESP_LOGI(TAG, "assets mounted, %u of %u KB used", (unsigned)(used / 1024),
                 (unsigned)(total / 1024));
        return;
    }
    ESP_LOGW(TAG, "no assets partition: %s", esp_err_to_name(err));
}

static esp_err_t mount_filesystem(void)
{
    const esp_vfs_littlefs_conf_t cfg = {
        .base_path = MOUNT_POINT,
        .partition_label = PARTITION_STORAGE,
        .format_if_mount_failed = true,
        .dont_mount = false,
    };
    APP_RETURN_ON_ERR(esp_vfs_littlefs_register(&cfg), TAG, "mount");
    mount_assets();
    mkdir(MOUNT_POINT "/db", 0777);
    mkdir(MOUNT_POINT "/log", 0777);
    mkdir(MOUNT_POINT "/cfg", 0777);
    return ESP_OK;
}

static esp_err_t open_settings(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        APP_RETURN_ON_ERR(nvs_flash_erase(), TAG, "nvs erase");
        err = nvs_flash_init();
    }
    return err;
}

// Handles are opened on demand and kept, since KEHOACH 6.2.1 names seven groups
// and a kiosk touches at most a few of them per boot.
static esp_err_t namespace_handle(const char *ns, nvs_handle_t *out)
{
    for (size_t i = 0; i < NVS_SLOTS; ++i) {
        if (s_slots[i].name != NULL && strcmp(s_slots[i].name, ns) == 0) {
            *out = s_slots[i].handle;
            return ESP_OK;
        }
    }
    for (size_t i = 0; i < NVS_SLOTS; ++i) {
        if (s_slots[i].name == NULL) {
            APP_RETURN_ON_ERR(nvs_open(ns, NVS_READWRITE, &s_slots[i].handle), TAG, ns);
            s_slots[i].name = ns;
            *out = s_slots[i].handle;
            return ESP_OK;
        }
    }
    return ESP_ERR_NO_MEM;
}

// local_id must not repeat across the life of the device (KEHOACH 6.2.5), so a
// count kept under the old flat namespace is carried into its group once.
static uint32_t stored_boot_count(nvs_handle_t sys)
{
    uint32_t count = 0;
    if (nvs_get_u32(sys, NVS_BOOT_COUNT, &count) == ESP_OK) {
        return count;
    }
    nvs_handle_t legacy;
    if (nvs_open(NVS_LEGACY_NAMESPACE, NVS_READONLY, &legacy) == ESP_OK) {
        if (nvs_get_u32(legacy, NVS_BOOT_COUNT, &count) != ESP_OK) {
            count = 0;
        }
        nvs_close(legacy);
    }
    return count;
}

esp_err_t sys_storage_init(void)
{
    if (s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    s_lock = xSemaphoreCreateMutex();
    if (s_lock == NULL) {
        return ESP_ERR_NO_MEM;
    }
    APP_RETURN_ON_ERR(open_settings(), TAG, "settings");
    APP_RETURN_ON_ERR(mount_filesystem(), TAG, "filesystem");

    nvs_handle_t sys;
    APP_RETURN_ON_ERR(namespace_handle(STORAGE_NS_SYS, &sys), TAG, "sys namespace");
    s_boot_count = stored_boot_count(sys) + 1;
    APP_RETURN_ON_ERR(nvs_set_u32(sys, NVS_BOOT_COUNT, s_boot_count), TAG, "boot count");
    APP_RETURN_ON_ERR(nvs_commit(sys), TAG, "commit");

    // Enrol leaves crops here and nothing reads them after a reboot, so the
    // directory starts empty rather than filling up over the device's life.
    empty_scratch();

    size_t total = 0, used = 0;
    esp_littlefs_info(PARTITION_STORAGE, &total, &used);
    s_ready = true;
    ESP_LOGI(TAG, "boot %" PRIu32 ", littlefs %u/%u KB", s_boot_count, (unsigned)(used / 1024),
             (unsigned)(total / 1024));
    return ESP_OK;
}

uint32_t sys_storage_boot_count(void)
{
    return s_boot_count;
}

esp_err_t sys_storage_device_id(char *out, size_t cap)
{
    if (out == NULL || cap < STORAGE_DEVICE_ID_CAP) { return ESP_ERR_INVALID_SIZE; }
    if (sys_storage_get_str(STORAGE_NS_DEVICE, NVS_SERIAL, out, cap) == ESP_OK &&
        out[0] != '\0') {
        return ESP_OK;
    }
    uint8_t mac[6] = { 0 };
    // eFuse survives erase-flash, so a wiped kiosk keeps its identity (KEHOACH 6.2.1).
    APP_RETURN_ON_ERR(esp_efuse_mac_get_default(mac), TAG, "efuse mac");
    snprintf(out, cap, DEVICE_ID_PREFIX "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2],
             mac[3], mac[4], mac[5]);
    return ESP_OK;
}

esp_err_t sys_storage_get_u32(const char *ns, const char *key, uint32_t *value)
{
    if (!s_ready || ns == NULL || key == NULL || value == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    APP_RETURN_ON_ERR(take(), TAG, "lock");
    nvs_handle_t handle;
    esp_err_t err = namespace_handle(ns, &handle);
    if (err == ESP_OK) {
        err = nvs_get_u32(handle, key, value);
    }
    give();
    return err;
}

esp_err_t sys_storage_get_str(const char *ns, const char *key, char *out, size_t cap)
{
    if (!s_ready || ns == NULL || key == NULL || out == NULL || cap == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    APP_RETURN_ON_ERR(take(), TAG, "lock");
    nvs_handle_t handle;
    size_t len = cap;
    esp_err_t err = namespace_handle(ns, &handle);
    if (err == ESP_OK) {
        err = nvs_get_str(handle, key, out, &len);
    }
    give();
    return err;
}

esp_err_t sys_storage_set_str(const char *ns, const char *key, const char *value)
{
    if (!s_ready || ns == NULL || key == NULL || value == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    APP_RETURN_ON_ERR(take(), TAG, "lock");
    nvs_handle_t handle;
    esp_err_t err = namespace_handle(ns, &handle);
    if (err == ESP_OK) {
        err = nvs_set_str(handle, key, value);
    }
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    give();
    return err;
}

esp_err_t sys_storage_set_u32(const char *ns, const char *key, uint32_t value)
{
    if (!s_ready || ns == NULL || key == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    APP_RETURN_ON_ERR(take(), TAG, "lock");
    nvs_handle_t handle;
    esp_err_t err = namespace_handle(ns, &handle);
    if (err == ESP_OK) {
        err = nvs_set_u32(handle, key, value);
    }
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    give();
    return err;
}

static esp_err_t write_whole(const char *path, const void *data, size_t len)
{
    FILE *file = fopen(path, "wb");
    if (file == NULL) {
        return ESP_ERR_NOT_FOUND;
    }
    const size_t written = fwrite(data, 1, len, file);
    // Closing alone leaves the bytes in LittleFS's cache, so a power cut there
    // loses a write the caller already counts as durable (KEHOACH 6.2.6).
    const int synced = fflush(file) == 0 ? fsync(fileno(file)) : -1;
    fclose(file);
    return (written == len && synced == 0) ? ESP_OK : ESP_FAIL;
}

static esp_err_t replace_locked(const char *path, const void *data, size_t len)
{
    char scratch[PATH_MAX_LEN];
    char previous[PATH_MAX_LEN];
    if (snprintf(scratch, sizeof(scratch), "%s.tmp", path) >= (int)sizeof(scratch) ||
        snprintf(previous, sizeof(previous), "%s.bak", path) >= (int)sizeof(previous)) {
        return ESP_ERR_INVALID_SIZE;
    }
    esp_err_t err = write_whole(scratch, data, len);
    if (err == ESP_OK) {
        // The old copy steps aside first, so the moment the new name appears
        // there is always a complete file under one of the two names.
        unlink(previous);
        rename(path, previous);
        err = rename(scratch, path) == 0 ? ESP_OK : ESP_FAIL;
    }
    if (err != ESP_OK) {
        unlink(scratch);
    }
    return err;
}

esp_err_t sys_storage_write_atomic(const char *path, const void *data, size_t len)
{
    if (!s_ready || path == NULL || data == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    APP_RETURN_ON_ERR(take(), TAG, "lock");
    const esp_err_t err = replace_locked(path, data, len);
    give();
    return err;
}

static esp_err_t read_locked(const char *path, void *buf, size_t cap, size_t *out_len)
{
    FILE *file = fopen(path, "rb");
    if (file == NULL) {
        return ESP_ERR_NOT_FOUND;
    }
    // The end-of-file flag only rises after a read runs past the last byte, so
    // a file exactly the size of the buffer would look like an overflow.
    fseek(file, 0, SEEK_END);
    const long size = ftell(file);
    rewind(file);
    if (size < 0 || (size_t)size > cap) {
        fclose(file);
        return ESP_ERR_INVALID_SIZE;
    }
    const size_t got = fread(buf, 1, (size_t)size, file);
    fclose(file);
    *out_len = got;
    return got == (size_t)size ? ESP_OK : ESP_FAIL;
}

esp_err_t sys_storage_read(const char *path, void *buf, size_t cap, size_t *out_len)
{
    if (!s_ready || path == NULL || buf == NULL || out_len == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    APP_RETURN_ON_ERR(take(), TAG, "lock");
    const esp_err_t err = read_locked(path, buf, cap, out_len);
    give();
    return err;
}

uint32_t sys_storage_crc32(const void *data, size_t len)
{
    return esp_crc32_le(0, (const uint8_t *)data, len);
}

static bool header_holds(const void *buf, size_t len, uint32_t magic)
{
    if (len < sizeof(storage_file_header_t)) {
        return false;
    }
    const storage_file_header_t *header = buf;
    const uint32_t crc = sys_storage_crc32(header, offsetof(storage_file_header_t, crc32));
    return header->magic == magic && header->crc32 == crc;
}

esp_err_t sys_storage_read_checked(const char *path, uint32_t magic, void *buf, size_t cap,
                                   size_t *out_len, bool *used_backup)
{
    if (path == NULL || used_backup == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    *used_backup = false;
    esp_err_t err = sys_storage_read(path, buf, cap, out_len);
    if (err == ESP_OK && header_holds(buf, *out_len, magic)) {
        return ESP_OK;
    }
    // Two-phase writing leaves a whole previous copy on purpose, and this is
    // the only path that spends it (KEHOACH 6.2.6).
    char previous[PATH_MAX_LEN];
    if (snprintf(previous, sizeof(previous), "%s.bak", path) >= (int)sizeof(previous)) {
        return ESP_ERR_INVALID_SIZE;
    }
    err = sys_storage_read(previous, buf, cap, out_len);
    if (err != ESP_OK || !header_holds(buf, *out_len, magic)) {
        return ESP_ERR_NOT_FOUND;
    }
    *used_backup = true;
    ESP_LOGW(TAG, "%s failed its check, backup served instead", path);
    return ESP_OK;
}

static esp_err_t append_locked(const char *path, const void *record, size_t len)
{
    FILE *file = fopen(path, "ab");
    if (file == NULL) {
        return ESP_ERR_NOT_FOUND;
    }
    const size_t written = fwrite(record, 1, len, file);
    const int synced = fflush(file) == 0 ? fsync(fileno(file)) : -1;
    fclose(file);
    return (written == len && synced == 0) ? ESP_OK : ESP_FAIL;
}

esp_err_t sys_storage_append(const char *path, const void *record, size_t len)
{
    if (!s_ready || path == NULL || record == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    APP_RETURN_ON_ERR(take(), TAG, "lock");
    const esp_err_t err = append_locked(path, record, len);
    give();
    return err;
}

static long file_size(const char *path)
{
    struct stat st;
    return stat(path, &st) == 0 ? (long)st.st_size : -1;
}

static esp_err_t read_at(const char *path, long offset, void *buf, size_t len)
{
    FILE *file = fopen(path, "rb");
    if (file == NULL) {
        return ESP_ERR_NOT_FOUND;
    }
    const size_t got = fseek(file, offset, SEEK_SET) == 0 ? fread(buf, 1, len, file) : 0;
    fclose(file);
    return got == len ? ESP_OK : ESP_FAIL;
}

static void log_path_of(uint32_t index, char *out, size_t cap)
{
    snprintf(out, cap, STORAGE_ATTEND_FMT, (unsigned)index);
}

static bool log_index_of(const char *name, uint32_t *index)
{
    if (strncmp(name, LOG_NAME_PREFIX, strlen(LOG_NAME_PREFIX)) != 0) {
        return false;
    }
    char *end = NULL;
    const unsigned long parsed = strtoul(name + strlen(LOG_NAME_PREFIX), &end, 10);
    if (*end != '\0' || parsed >= STORAGE_ATTEND_FILES) {
        return false;
    }
    *index = (uint32_t)parsed;
    return true;
}

static uint32_t newest_log_index(void)
{
    DIR *dir = opendir(STORAGE_ATTEND_DIR);
    if (dir == NULL) {
        return 0;
    }
    uint32_t newest = 0;
    uint32_t index = 0;
    for (struct dirent *entry = readdir(dir); entry != NULL; entry = readdir(dir)) {
        if (log_index_of(entry->d_name, &index) && index > newest) {
            newest = index;
        }
    }
    closedir(dir);
    return newest;
}

static esp_err_t write_log_header(const char *path)
{
    storage_file_header_t header = { 0 };
    header.magic = STORAGE_ATTEND_MAGIC;
    header.format_ver = STORAGE_ATTEND_VER;
    header.record_size = LOG_RECORD_BYTES;
    header.updated_at_ms = (int64_t)time(NULL) * 1000;
    header.crc32 = sys_storage_crc32(&header, offsetof(storage_file_header_t, crc32));
    return write_whole(path, &header, sizeof(header));
}

static bool log_header_holds(const char *path)
{
    storage_file_header_t header;
    if (read_at(path, 0, &header, sizeof(header)) != ESP_OK) {
        return false;
    }
    const uint32_t crc = sys_storage_crc32(&header, offsetof(storage_file_header_t, crc32));
    return header.magic == STORAGE_ATTEND_MAGIC && header.crc32 == crc &&
           header.record_size == LOG_RECORD_BYTES;
}

// Names the file the next record goes into, creating it or rotating on to the
// next name as KEHOACH 6.2.6 says.
static esp_err_t active_log(char *path, size_t cap)
{
    if (!s_log_scanned) {
        s_log_index = newest_log_index();
        s_log_scanned = true;
    }
    while (s_log_index < STORAGE_ATTEND_FILES) {
        log_path_of(s_log_index, path, cap);
        long size = file_size(path);
        // Absent, or a header the last power cut never finished: no record can
        // live in those bytes, so the file starts over.
        if (size < (long)LOG_HEADER_BYTES) {
            return write_log_header(path);
        }
        if (!log_header_holds(path)) {
            ESP_LOGE(TAG, "%s carries no log header, rotating past it", path);
            ++s_log_index;
            continue;
        }
        const long partial = (size - (long)LOG_HEADER_BYTES) % (long)LOG_RECORD_BYTES;
        if (partial != 0) {
            if (truncate(path, size - partial) != 0) {
                ESP_LOGE(TAG, "%s keeps a %ld B tail, rotating past it", path, partial);
                ++s_log_index;
                continue;
            }
            ESP_LOGW(TAG, "%s ended %ld B into a record, tail dropped", path, partial);
            size -= partial;
        }
        if ((size_t)size + LOG_RECORD_BYTES > STORAGE_ATTEND_ROTATE_BYTES) {
            ++s_log_index;
            continue;
        }
        return ESP_OK;
    }
    return ESP_ERR_NO_MEM;
}

esp_err_t sys_storage_attend_append(const storage_attend_record_t *record)
{
    if (!s_ready || record == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    APP_RETURN_ON_ERR(take(), TAG, "lock");
    char path[PATH_MAX_LEN];
    esp_err_t err = active_log(path, sizeof(path));
    if (err == ESP_OK) {
        err = append_locked(path, record, sizeof(*record));
    }
    give();
    return err;
}

static void cursor_of(storage_cursor_t *out, uint32_t index, uint32_t offset)
{
    memset(out, 0, sizeof(*out));
    out->magic = STORAGE_CURSOR_MAGIC;
    out->format_ver = STORAGE_CURSOR_VER;
    out->file_index = (uint16_t)index;
    out->offset = offset;
    out->crc32 = sys_storage_crc32(out, offsetof(storage_cursor_t, crc32));
}

static bool cursor_holds(const storage_cursor_t *cursor, size_t len)
{
    if (len != sizeof(*cursor)) {
        return false;
    }
    const uint32_t crc = sys_storage_crc32(cursor, offsetof(storage_cursor_t, crc32));
    return cursor->magic == STORAGE_CURSOR_MAGIC && cursor->crc32 == crc &&
           cursor->format_ver == STORAGE_CURSOR_VER;
}

static void load_cursor(storage_cursor_t *out)
{
    size_t len = 0;
    if (read_locked(STORAGE_CURSOR_PATH, out, sizeof(*out), &len) == ESP_OK &&
        cursor_holds(out, len)) {
        return;
    }
    if (read_locked(STORAGE_CURSOR_PATH ".bak", out, sizeof(*out), &len) == ESP_OK &&
        cursor_holds(out, len)) {
        ESP_LOGW(TAG, "cursor.bin failed its check, its backup answered");
        return;
    }
    cursor_of(out, 0, LOG_HEADER_BYTES);
}

esp_err_t sys_storage_attend_cursor_get(storage_cursor_t *out)
{
    if (!s_ready || out == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    APP_RETURN_ON_ERR(take(), TAG, "lock");
    load_cursor(out);
    give();
    return ESP_OK;
}

// A file goes only once the cursor sits past it, and only once per session per
// name, so a cursor moving inside one file costs no lookups (KEHOACH 6.2.6).
static void drop_synced_logs(uint32_t below)
{
    char path[PATH_MAX_LEN];
    for (; s_log_dropped_below < below; ++s_log_dropped_below) {
        log_path_of(s_log_dropped_below, path, sizeof(path));
        if (unlink(path) == 0) {
            ESP_LOGI(TAG, "%s synced through, dropped", path);
        }
    }
}

esp_err_t sys_storage_attend_cursor_set(const storage_cursor_t *cursor)
{
    if (!s_ready || cursor == NULL || cursor->file_index >= STORAGE_ATTEND_FILES ||
        cursor->offset < LOG_HEADER_BYTES ||
        (cursor->offset - LOG_HEADER_BYTES) % LOG_RECORD_BYTES != 0) {
        return ESP_ERR_INVALID_ARG;
    }
    storage_cursor_t stamped;
    cursor_of(&stamped, cursor->file_index, cursor->offset);

    APP_RETURN_ON_ERR(take(), TAG, "lock");
    const esp_err_t err = replace_locked(STORAGE_CURSOR_PATH, &stamped, sizeof(stamped));
    if (err == ESP_OK) {
        drop_synced_logs(stamped.file_index);
    }
    give();
    return err;
}

esp_err_t sys_storage_attend_read(const storage_cursor_t *at, storage_attend_record_t *out,
                                  storage_cursor_t *next)
{
    if (!s_ready || at == NULL || out == NULL || next == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    APP_RETURN_ON_ERR(take(), TAG, "lock");
    if (!s_log_scanned) {
        s_log_index = newest_log_index();
        s_log_scanned = true;
    }
    char path[PATH_MAX_LEN];
    long offset = at->offset < LOG_HEADER_BYTES ? (long)LOG_HEADER_BYTES : (long)at->offset;
    esp_err_t err = ESP_ERR_NOT_FOUND;
    for (uint32_t index = at->file_index; index <= s_log_index; ++index) {
        log_path_of(index, path, sizeof(path));
        const long size = file_size(path);
        while (size >= offset + (long)LOG_RECORD_BYTES) {
            err = read_at(path, offset, out, sizeof(*out));
            offset += (long)LOG_RECORD_BYTES;
            if (err != ESP_OK) {
                break;
            }
            const uint32_t crc = sys_storage_crc32(out, offsetof(storage_attend_record_t, crc32));
            if (out->magic == STORAGE_ATTEND_REC_MAGIC && out->crc32 == crc) {
                cursor_of(next, index, (uint32_t)offset);
                give();
                return ESP_OK;
            }
            // KEHOACH 6.2.6 drops such a record, and the cursor has to be able
            // to move past it or the uplink stalls here forever.
            ESP_LOGW(TAG, "%s record at %ld failed its check, skipped", path,
                     offset - (long)LOG_RECORD_BYTES);
            err = ESP_ERR_NOT_FOUND;
        }
        offset = (long)LOG_HEADER_BYTES;
    }
    give();
    return err;
}

esp_err_t sys_storage_models_open(const storage_models_header_t **header)
{
    if (!s_ready || header == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_models != NULL) {
        *header = s_models;
        return ESP_OK;
    }
    const esp_partition_t *part = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, PARTITION_MODELS);
    if (part == NULL) {
        return ESP_ERR_NOT_FOUND;
    }
    const void *base = NULL;
    APP_RETURN_ON_ERR(esp_partition_mmap(part, 0, part->size, ESP_PARTITION_MMAP_DATA, &base,
                                         &s_models_map),
                      TAG, "mmap");

    const storage_models_header_t *candidate = base;
    // An erased partition reads back all ones, so a wrong magic means no image
    // has been written yet; only a matching magic makes a bad crc corruption.
    if (candidate->magic != STORAGE_MODELS_MAGIC) {
        esp_partition_munmap(s_models_map);
        ESP_LOGE(TAG, "no models image: magic %08" PRIx32, candidate->magic);
        return ESP_ERR_NOT_FOUND;
    }
    const uint32_t crc = esp_crc32_le(0, (const uint8_t *)candidate,
                                      offsetof(storage_models_header_t, crc32));
    if (crc != candidate->crc32 || candidate->format_ver != STORAGE_MODELS_VER) {
        esp_partition_munmap(s_models_map);
        ESP_LOGE(TAG, "models header v%" PRIu32 " crc %08" PRIx32 " vs %08" PRIx32,
                 candidate->format_ver, crc, candidate->crc32);
        return ESP_ERR_INVALID_CRC;
    }
    s_models_bytes = part->size;
    s_models_base = base;
    s_models = candidate;
    *header = s_models;
    ESP_LOGI(TAG, "models v%" PRIu32 ", %" PRIu32 " entries", s_models->format_ver,
             s_models->count);
    return ESP_OK;
}

esp_err_t sys_storage_model_find(const char *name, const void **data, size_t *size,
                                 uint32_t *arena_hint_bytes)
{
    if (s_models == NULL || name == NULL || data == NULL || size == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    for (uint32_t i = 0; i < s_models->count && i < STORAGE_MODEL_COUNT; ++i) {
        const storage_model_entry_t *entry = &s_models->entry[i];
        if (strncmp(entry->name, name, STORAGE_MODEL_NAME_LEN) != 0) {
            continue;
        }
        // The header crc covers the header, not the payloads, so an entry can
        // point anywhere; esp-nn also needs the weights 16-byte aligned.
        if (entry->size == 0 || entry->offset < sizeof(*s_models) ||
            entry->offset % STORAGE_MODEL_ALIGN != 0 ||
            (uint64_t)entry->offset + entry->size > s_models_bytes) {
            ESP_LOGE(TAG, "%s entry offset %" PRIu32 " size %" PRIu32 " outside %u B partition",
                     name, entry->offset, entry->size, (unsigned)s_models_bytes);
            return ESP_ERR_INVALID_SIZE;
        }
        const uint8_t *payload = s_models_base + entry->offset;
        if (memcmp(payload + 4, "TFL3", 4) != 0) {
            ESP_LOGE(TAG, "%s is not a tflite flatbuffer", name);
            return ESP_ERR_INVALID_SIZE;
        }
        *data = payload;
        *size = entry->size;
        if (arena_hint_bytes != NULL) {
            *arena_hint_bytes = entry->arena_hint;
        }
        return ESP_OK;
    }
    return ESP_ERR_NOT_FOUND;
}
