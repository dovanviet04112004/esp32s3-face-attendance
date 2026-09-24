#include "facedb_internal.hpp"

#include <string.h>

#include "app_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "lock_guard.hpp"
#include "sys_storage.h"

namespace facedb {

namespace {

const char *TAG = "svc_facedb";

constexpr uint32_t kLockMs = 200;
// A writer queues behind a 1.8-2.3 s save of the whole table (KEHOACH 6.2.4).
constexpr uint32_t kIoLockMs = 4000;
constexpr size_t kImageAlign = 16;
constexpr size_t kHeaderCrcBytes = offsetof(storage_file_header_t, crc32);
constexpr size_t kRecordCrcBytes = offsetof(storage_face_record_t, crc32);
// Deleting only flags a record; the file drops the dead ones past this share (KEHOACH 6.2.4).
constexpr size_t kCompactDeadPercent = 30;

bool live(const storage_face_record_t &rec) noexcept
{
    return (rec.flags & STORAGE_FACE_FLAG_ACTIVE) != 0 && (rec.flags & STORAGE_FACE_FLAG_DELETED) == 0;
}

}  // namespace

esp_err_t EmbeddingTable::reserve(size_t capacity) noexcept
{
    if (image_ != nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    if (capacity == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    const size_t bytes = sizeof(storage_file_header_t) + capacity * sizeof(storage_face_record_t);
    // Header 32 B and record 576 B are both multiples of 8, so every embedding
    // sits 8-byte aligned once the image does (the SIMD kernel needs that).
    image_ = static_cast<uint8_t *>(heap_caps_aligned_calloc(kImageAlign, 1, bytes, MALLOC_CAP_SPIRAM));
    norm_sq_ = static_cast<uint32_t *>(heap_caps_calloc(capacity, sizeof(uint32_t), MALLOC_CAP_SPIRAM));
    if (image_ == nullptr || norm_sq_ == nullptr) {
        heap_caps_free(image_);
        heap_caps_free(norm_sq_);
        image_ = nullptr;
        norm_sq_ = nullptr;
        return ESP_ERR_NO_MEM;
    }
    capacity_ = capacity;
    return ESP_OK;
}

storage_file_header_t &EmbeddingTable::header() noexcept
{
    return *reinterpret_cast<storage_file_header_t *>(image_);
}

storage_face_record_t *EmbeddingTable::record(size_t index) noexcept
{
    return reinterpret_cast<storage_face_record_t *>(image_ + sizeof(storage_file_header_t)) + index;
}

const storage_face_record_t *EmbeddingTable::record(size_t index) const noexcept
{
    return reinterpret_cast<const storage_face_record_t *>(image_ + sizeof(storage_file_header_t)) + index;
}

size_t EmbeddingTable::image_bytes() const noexcept
{
    return sizeof(storage_file_header_t) + count_ * sizeof(storage_face_record_t);
}

size_t EmbeddingTable::image_capacity() const noexcept
{
    return sizeof(storage_file_header_t) + capacity_ * sizeof(storage_face_record_t);
}

esp_err_t FaceDb::init(size_t capacity) noexcept
{
    if (mutex_ != nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    APP_RETURN_ON_ERR(table_.reserve(capacity), TAG, "table");
    mutex_ = xSemaphoreCreateMutex();
    io_mutex_ = xSemaphoreCreateMutex();
    if (mutex_ == nullptr || io_mutex_ == nullptr) {
        return ESP_ERR_NO_MEM;
    }
    const esp_err_t loaded = load();
    if (loaded == ESP_ERR_NOT_FOUND) {
        table_.set_count(0);
        active_ = 0;
        seal_header();
        ESP_LOGI(TAG, "no %s yet, table starts empty, capacity %u", STORAGE_FACES_PATH,
                 static_cast<unsigned>(capacity));
        return ESP_OK;
    }
    if (loaded != ESP_OK) {
        ESP_LOGE(TAG, "%s: %s", STORAGE_FACES_PATH, esp_err_to_name(loaded));
        return loaded;
    }
    ESP_LOGI(TAG, "%u templates in %s, %u active, capacity %u", static_cast<unsigned>(table_.count()),
             STORAGE_FACES_PATH, static_cast<unsigned>(active_), static_cast<unsigned>(capacity));
    return ESP_OK;
}

esp_err_t FaceDb::load() noexcept
{
    size_t len = 0;
    const esp_err_t err = store_.load(table_.image(), table_.image_capacity(), &len);
    if (err != ESP_OK) {
        return err;
    }
    const storage_file_header_t &head = table_.header();
    if (head.format_ver != STORAGE_FACES_VER || head.record_size != sizeof(storage_face_record_t)) {
        ESP_LOGE(TAG, "format %u with %u byte records is not this firmware's", head.format_ver,
                 head.record_size);
        return ESP_ERR_INVALID_VERSION;
    }
    const size_t in_file = (len - sizeof(storage_file_header_t)) / sizeof(storage_face_record_t);
    const size_t count = head.record_count < in_file ? head.record_count : in_file;
    size_t kept = 0;
    active_ = 0;
    for (size_t i = 0; i < count; ++i) {
        const storage_face_record_t *rec = table_.record(i);
        if (rec->magic != STORAGE_FACE_MAGIC || rec->crc32 != sys_storage_crc32(rec, kRecordCrcBytes)) {
            ESP_LOGW(TAG, "record %u failed its check, dropped", static_cast<unsigned>(i));
            continue;
        }
        if (kept != i) {
            memcpy(table_.record(kept), rec, sizeof(storage_face_record_t));
        }
        table_.set_norm_sq(kept, norm_sq(table_.record(kept)->embedding));
        active_ += live(*table_.record(kept)) ? 1 : 0;
        ++kept;
    }
    table_.set_count(kept);
    return ESP_OK;
}

esp_err_t FaceDb::lookup(const int8_t *emb, float scale, MatchResult *out) noexcept
{
    if (emb == nullptr || out == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    app::LockGuard lock(mutex_, kLockMs);
    if (!lock.held()) {
        return ESP_ERR_TIMEOUT;
    }
    *out = matcher_.best(emb, scale);
    return out->found ? ESP_OK : ESP_ERR_NOT_FOUND;
}

esp_err_t FaceDb::enroll(uint32_t employee_id, uint16_t template_idx, uint8_t quality, const int8_t *emb,
                         float scale, const char *name) noexcept
{
    if (emb == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    app::LockGuard io(io_mutex_, kIoLockMs);
    if (!io.held()) {
        return ESP_ERR_TIMEOUT;
    }
    app::LockGuard lock(mutex_, kLockMs);
    if (!lock.held()) {
        return ESP_ERR_TIMEOUT;
    }
    size_t slot = table_.count();
    for (size_t i = 0; i < table_.count(); ++i) {
        const storage_face_record_t *rec = table_.record(i);
        if (live(*rec) && rec->employee_id == employee_id && rec->template_idx == template_idx) {
            slot = i;
            break;
        }
    }
    if (slot == table_.count()) {
        if (table_.count() == table_.capacity()) {
            compact();
        }
        if (table_.count() == table_.capacity()) {
            return ESP_ERR_NO_MEM;
        }
        slot = table_.count();
        table_.set_count(slot + 1);
        ++active_;
    }
    storage_face_record_t *rec = table_.record(slot);
    memset(rec, 0, sizeof(*rec));
    rec->magic = STORAGE_FACE_MAGIC;
    rec->employee_id = employee_id;
    rec->template_idx = template_idx;
    rec->quality = quality;
    rec->flags = STORAGE_FACE_FLAG_ACTIVE;
    rec->scale = scale;
    memcpy(rec->embedding, emb, STORAGE_EMBED_DIM);
    if (name != NULL) {
        strncpy(rec->name, name, sizeof(rec->name) - 1);
    }
    table_.set_norm_sq(slot, norm_sq(emb));
    seal(slot);
    return ESP_OK;
}

esp_err_t FaceDb::remove(uint32_t employee_id) noexcept
{
    app::LockGuard io(io_mutex_, kIoLockMs);
    if (!io.held()) {
        return ESP_ERR_TIMEOUT;
    }
    app::LockGuard lock(mutex_, kLockMs);
    if (!lock.held()) {
        return ESP_ERR_TIMEOUT;
    }
    size_t hits = 0;
    for (size_t i = 0; i < table_.count(); ++i) {
        storage_face_record_t *rec = table_.record(i);
        if (live(*rec) && rec->employee_id == employee_id) {
            rec->flags = static_cast<uint8_t>((rec->flags | STORAGE_FACE_FLAG_DELETED) & ~STORAGE_FACE_FLAG_ACTIVE);
            seal(i);
            ++hits;
        }
    }
    active_ -= hits;
    return hits > 0 ? ESP_OK : ESP_ERR_NOT_FOUND;
}

esp_err_t FaceDb::remove_template(uint32_t employee_id, uint16_t template_idx) noexcept
{
    app::LockGuard io(io_mutex_, kIoLockMs);
    if (!io.held()) {
        return ESP_ERR_TIMEOUT;
    }
    app::LockGuard lock(mutex_, kLockMs);
    if (!lock.held()) {
        return ESP_ERR_TIMEOUT;
    }
    for (size_t i = 0; i < table_.count(); ++i) {
        storage_face_record_t *rec = table_.record(i);
        if (live(*rec) && rec->employee_id == employee_id && rec->template_idx == template_idx) {
            rec->flags = static_cast<uint8_t>((rec->flags | STORAGE_FACE_FLAG_DELETED) & ~STORAGE_FACE_FLAG_ACTIVE);
            seal(i);
            --active_;
            return ESP_OK;
        }
    }
    return ESP_ERR_NOT_FOUND;
}

esp_err_t FaceDb::clear() noexcept
{
    app::LockGuard io(io_mutex_, kIoLockMs);
    if (!io.held()) {
        return ESP_ERR_TIMEOUT;
    }
    app::LockGuard lock(mutex_, kLockMs);
    if (!lock.held()) {
        return ESP_ERR_TIMEOUT;
    }
    for (size_t i = 0; i < table_.count(); ++i) {
        storage_face_record_t *rec = table_.record(i);
        if (live(*rec)) {
            rec->flags = static_cast<uint8_t>((rec->flags | STORAGE_FACE_FLAG_DELETED) & ~STORAGE_FACE_FLAG_ACTIVE);
            seal(i);
        }
    }
    active_ = 0;
    return ESP_OK;
}

esp_err_t FaceDb::templet(uint32_t employee_id, uint16_t template_idx, int8_t *emb, size_t cap,
                          float *scale, uint8_t *quality) noexcept
{
    if (emb == nullptr || cap < STORAGE_EMBED_DIM || scale == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    app::LockGuard lock(mutex_, kLockMs);
    if (!lock.held()) {
        return ESP_ERR_TIMEOUT;
    }
    for (size_t i = 0; i < table_.count(); ++i) {
        const storage_face_record_t *rec = table_.record(i);
        if (!live(*rec) || rec->employee_id != employee_id || rec->template_idx != template_idx) {
            continue;
        }
        memcpy(emb, rec->embedding, STORAGE_EMBED_DIM);
        *scale = rec->scale;
        if (quality != nullptr) {
            *quality = rec->quality;
        }
        return ESP_OK;
    }
    return ESP_ERR_NOT_FOUND;
}

size_t FaceDb::people(svc_facedb_person_t *out, size_t cap) noexcept
{
    app::LockGuard lock(mutex_, kLockMs);
    if (!lock.held() || out == nullptr) {
        return 0;
    }
    size_t kept = 0;
    for (size_t i = 0; i < table_.count(); ++i) {
        const storage_face_record_t *rec = table_.record(i);
        if (!live(*rec)) {
            continue;
        }
        size_t at = kept;
        for (size_t j = 0; j < kept; ++j) {
            if (out[j].employee_id == rec->employee_id) {
                at = j;
                break;
            }
        }
        if (at == kept) {
            if (kept == cap) {
                break;
            }
            out[at].employee_id = rec->employee_id;
            out[at].templates = 0;
            strlcpy(out[at].name, rec->name, sizeof(out[at].name));
            ++kept;
        }
        ++out[at].templates;
    }
    return kept;
}

esp_err_t FaceDb::persist() noexcept
{
    app::LockGuard io(io_mutex_, kIoLockMs);
    if (!io.held()) {
        return ESP_ERR_TIMEOUT;
    }
    size_t bytes = 0;
    {
        app::LockGuard lock(mutex_, kLockMs);
        if (!lock.held()) {
            return ESP_ERR_TIMEOUT;
        }
        const size_t dead = table_.count() - active_;
        if (dead * 100 > table_.count() * kCompactDeadPercent) {
            compact();
        }
        seal_header();
        bytes = table_.image_bytes();
    }
    // m_facedb_io alone covers the save, so a lookup never waits on it (KEHOACH 5.3).
    return store_.save(table_.image(), bytes);
}

void FaceDb::compact() noexcept
{
    size_t kept = 0;
    for (size_t i = 0; i < table_.count(); ++i) {
        if (!live(*table_.record(i))) {
            continue;
        }
        if (kept != i) {
            memcpy(table_.record(kept), table_.record(i), sizeof(storage_face_record_t));
            table_.set_norm_sq(kept, table_.norm_sq(i));
        }
        ++kept;
    }
    table_.set_count(kept);
    active_ = kept;
}

void FaceDb::seal(size_t index) noexcept
{
    storage_face_record_t *rec = table_.record(index);
    rec->crc32 = sys_storage_crc32(rec, kRecordCrcBytes);
}

void FaceDb::seal_header() noexcept
{
    storage_file_header_t &head = table_.header();
    memset(&head, 0, sizeof(head));
    head.magic = STORAGE_FACES_MAGIC;
    head.format_ver = STORAGE_FACES_VER;
    head.record_size = sizeof(storage_face_record_t);
    head.record_count = static_cast<uint32_t>(table_.count());
    // No wall clock reaches this component yet, and zero reads as unknown.
    head.updated_at_ms = 0;
    head.crc32 = sys_storage_crc32(&head, kHeaderCrcBytes);
}

}  // namespace facedb
