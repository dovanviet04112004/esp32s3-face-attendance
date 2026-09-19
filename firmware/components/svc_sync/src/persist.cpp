#include "uplink.hpp"

namespace uplink {

esp_err_t LittleFsPersist::cursor_get(storage_cursor_t *out) noexcept
{
    return sys_storage_attend_cursor_get(out);
}

esp_err_t LittleFsPersist::cursor_set(const storage_cursor_t *cursor) noexcept
{
    return sys_storage_attend_cursor_set(cursor);
}

esp_err_t LittleFsPersist::read(const storage_cursor_t *at, storage_attend_record_t *out,
                                storage_cursor_t *next) noexcept
{
    return sys_storage_attend_read(at, out, next);
}

}  // namespace uplink
