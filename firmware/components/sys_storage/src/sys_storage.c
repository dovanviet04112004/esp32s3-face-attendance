#include "sys_storage.h"

#include <dirent.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "app_err.h"
#include "esp_crc.h"
#include "esp_littlefs.h"
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
#define NVS_LEGACY_NAMESPACE "kiosk"
#define NVS_BOOT_COUNT "boot_count"
#define NVS_SLOTS 6
#define LOCK_WAIT_MS 5000
#define PATH_MAX_LEN 64
// LittleFS allows a 255 byte name, and the compiler checks that the join fits.
#define SCRATCH_PATH_LEN (sizeof(SCRATCH_DIR) + 1 + 255)

typedef struct {
    const char *name;
    nvs_handle_t handle;
} nvs_slot_t;

static SemaphoreHandle_t s_lock;
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

static esp_err_t mount_filesystem(void)
{
    const esp_vfs_littlefs_conf_t cfg = {
        .base_path = MOUNT_POINT,
        .partition_label = PARTITION_STORAGE,
        .format_if_mount_failed = true,
        .dont_mount = false,
    };
    APP_RETURN_ON_ERR(esp_vfs_littlefs_register(&cfg), TAG, "mount");
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

// Handles are opened on demand and kept, since KEHOACH 6.2.1 names six groups
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

esp_err_t sys_storage_write_atomic(const char *path, const void *data, size_t len)
{
    if (!s_ready || path == NULL || data == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    char scratch[PATH_MAX_LEN];
    char previous[PATH_MAX_LEN];
    if (snprintf(scratch, sizeof(scratch), "%s.tmp", path) >= (int)sizeof(scratch) ||
        snprintf(previous, sizeof(previous), "%s.bak", path) >= (int)sizeof(previous)) {
        return ESP_ERR_INVALID_SIZE;
    }

    APP_RETURN_ON_ERR(take(), TAG, "lock");
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
    give();
    return err;
}

esp_err_t sys_storage_read(const char *path, void *buf, size_t cap, size_t *out_len)
{
    if (!s_ready || path == NULL || buf == NULL || out_len == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    APP_RETURN_ON_ERR(take(), TAG, "lock");
    FILE *file = fopen(path, "rb");
    if (file == NULL) {
        give();
        return ESP_ERR_NOT_FOUND;
    }
    // The end-of-file flag only rises after a read runs past the last byte, so
    // a file exactly the size of the buffer would look like an overflow.
    fseek(file, 0, SEEK_END);
    const long size = ftell(file);
    rewind(file);
    if (size < 0 || (size_t)size > cap) {
        fclose(file);
        give();
        return ESP_ERR_INVALID_SIZE;
    }
    const size_t got = fread(buf, 1, (size_t)size, file);
    fclose(file);
    give();
    *out_len = got;
    return got == (size_t)size ? ESP_OK : ESP_FAIL;
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

esp_err_t sys_storage_append(const char *path, const void *record, size_t len)
{
    if (!s_ready || path == NULL || record == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    APP_RETURN_ON_ERR(take(), TAG, "lock");
    FILE *file = fopen(path, "ab");
    if (file == NULL) {
        give();
        return ESP_ERR_NOT_FOUND;
    }
    const size_t written = fwrite(record, 1, len, file);
    const int synced = fflush(file) == 0 ? fsync(fileno(file)) : -1;
    fclose(file);
    give();
    return (written == len && synced == 0) ? ESP_OK : ESP_FAIL;
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
