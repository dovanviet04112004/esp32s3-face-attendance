/** The table, the matcher and the store behind svc_facedb.h (KEHOACH 4.5.5g).
 *  @ctx task | FaceDb methods take m_facedb, nothing else here locks
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "storage_format.h"

namespace facedb {

struct MatchResult {
    uint32_t employee_id;
    uint16_t template_idx;
    float score;
    bool found;
    const char *name;                     // points into the table, never copied
};

/** The file image itself, header first, so persisting is one write of this block.
 *  @ctx task | reserve once at init, then read and written under m_facedb
 */
class EmbeddingTable {
public:
    EmbeddingTable() = default;
    EmbeddingTable(const EmbeddingTable &) = delete;
    EmbeddingTable &operator=(const EmbeddingTable &) = delete;

    esp_err_t reserve(size_t capacity) noexcept;
    storage_file_header_t &header() noexcept;
    storage_face_record_t *record(size_t index) noexcept;
    const storage_face_record_t *record(size_t index) const noexcept;
    uint32_t norm_sq(size_t index) const noexcept { return norm_sq_[index]; }
    void set_norm_sq(size_t index, uint32_t value) noexcept { norm_sq_[index] = value; }
    size_t count() const noexcept { return count_; }
    void set_count(size_t count) noexcept { count_ = count; }
    size_t capacity() const noexcept { return capacity_; }
    uint8_t *image() noexcept { return image_; }
    size_t image_bytes() const noexcept;
    size_t image_capacity() const noexcept;

private:
    uint8_t *image_ = nullptr;
    uint32_t *norm_sq_ = nullptr;
    size_t capacity_ = 0;
    size_t count_ = 0;
};

class IMatcher {
public:
    virtual ~IMatcher() = default;
    virtual MatchResult best(const int8_t *emb, float scale) const noexcept = 0;
};

class CosineLinearMatcher final : public IMatcher {
public:
    explicit CosineLinearMatcher(const EmbeddingTable &table) noexcept : table_(table) {}
    MatchResult best(const int8_t *emb, float scale) const noexcept override;

private:
    const EmbeddingTable &table_;
};

class IPersist {
public:
    virtual ~IPersist() = default;
    virtual esp_err_t load(uint8_t *image, size_t cap, size_t *len) noexcept = 0;
    virtual esp_err_t save(const uint8_t *image, size_t len) noexcept = 0;
};

class LittleFsPersist final : public IPersist {
public:
    esp_err_t load(uint8_t *image, size_t cap, size_t *len) noexcept override;
    esp_err_t save(const uint8_t *image, size_t len) noexcept override;
};

/** Sum of squares of one embedding, the half of every cosine a record can keep.
 *  @ctx any | non-blocking
 */
uint32_t norm_sq(const int8_t *emb) noexcept;

class FaceDb {
public:
    explicit FaceDb(IPersist &store) noexcept : matcher_(table_), store_(store) {}
    FaceDb(const FaceDb &) = delete;
    FaceDb &operator=(const FaceDb &) = delete;

    esp_err_t init(size_t capacity) noexcept;
    esp_err_t lookup(const int8_t *emb, float scale, MatchResult *out) noexcept;
    esp_err_t enroll(uint32_t employee_id, uint16_t template_idx, uint8_t quality,
                     const int8_t *emb, float scale, const char *name) noexcept;
    esp_err_t remove(uint32_t employee_id) noexcept;
    esp_err_t persist() noexcept;
    size_t active() const noexcept { return active_; }

private:
    esp_err_t load() noexcept;
    void compact() noexcept;
    void seal(size_t index) noexcept;
    void seal_header() noexcept;

    EmbeddingTable table_;
    CosineLinearMatcher matcher_;
    IPersist &store_;
    SemaphoreHandle_t mutex_ = nullptr;
    // Lock order: m_facedb_io -> m_facedb (KEHOACH 5.3).
    SemaphoreHandle_t io_mutex_ = nullptr;
    size_t active_ = 0;
};

}  // namespace facedb
