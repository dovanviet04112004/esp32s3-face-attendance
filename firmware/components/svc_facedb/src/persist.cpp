#include "facedb_internal.hpp"

#include "esp_log.h"
#include "sys_storage.h"

namespace facedb {

namespace {

const char *TAG = "svc_facedb";

}  // namespace

esp_err_t LittleFsPersist::load(uint8_t *image, size_t cap, size_t *len) noexcept
{
    bool used_backup = false;
    const esp_err_t err =
        sys_storage_read_checked(STORAGE_FACES_PATH, STORAGE_FACES_MAGIC, image, cap, len, &used_backup);
    if (err == ESP_OK && used_backup) {
        ESP_LOGW(TAG, "%s served from its backup copy", STORAGE_FACES_PATH);
    }
    return err;
}

esp_err_t LittleFsPersist::save(const uint8_t *image, size_t len) noexcept
{
    return sys_storage_write_atomic(STORAGE_FACES_PATH, image, len);
}

}  // namespace facedb
