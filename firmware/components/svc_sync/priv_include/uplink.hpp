/** The seam over the attendance log and the queue that drains it (KEHOACH 4.5.5).
 *  @ctx sync_task | every method blocks on flash or on the broker
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "storage_format.h"
#include "svc_sync.h"
#include "sys_storage.h"

namespace uplink {

class IPersist {
public:
    virtual ~IPersist() = default;
    virtual esp_err_t cursor_get(storage_cursor_t *out) noexcept = 0;
    virtual esp_err_t cursor_set(const storage_cursor_t *cursor) noexcept = 0;
    virtual esp_err_t read(const storage_cursor_t *at, storage_attend_record_t *out,
                           storage_cursor_t *next) noexcept = 0;
};

class LittleFsPersist final : public IPersist {
public:
    esp_err_t cursor_get(storage_cursor_t *out) noexcept override;
    esp_err_t cursor_set(const storage_cursor_t *cursor) noexcept override;
    esp_err_t read(const storage_cursor_t *at, storage_attend_record_t *out,
                   storage_cursor_t *next) noexcept override;
};

class ILink {
public:
    virtual ~ILink() = default;
    virtual bool up() const noexcept = 0;
    virtual esp_err_t send(const char *payload, size_t len, uint32_t timeout_ms) noexcept = 0;
};

class MqttLink final : public ILink {
public:
    bool up() const noexcept override;
    esp_err_t send(const char *payload, size_t len, uint32_t timeout_ms) noexcept override;
};

class UplinkQueue {
public:
    UplinkQueue(IPersist &store, ILink &link) noexcept : store_(store), link_(link) {}
    UplinkQueue(const UplinkQueue &) = delete;
    UplinkQueue &operator=(const UplinkQueue &) = delete;

    esp_err_t init(const char *device_id) noexcept;
    esp_err_t drain(size_t batch, uint32_t ack_timeout_ms) noexcept;
    bool pending() const noexcept { return stats_.backlog; }
    svc_sync_stats_t stats() const noexcept { return stats_; }

private:
    // Long enough for the widest record the schema can produce (KEHOACH 6.2.5).
    static constexpr size_t kPayloadCap = 320;

    bool encode(const storage_attend_record_t &rec, char *out, size_t cap) const noexcept;

    IPersist &store_;
    ILink &link_;
    char device_id_[STORAGE_DEVICE_ID_CAP] = {};
    svc_sync_stats_t stats_ = {};
};

}  // namespace uplink
