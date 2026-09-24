#include "svc_facedb.h"

#include "facedb_internal.hpp"
#include <string.h>

#include "sdkconfig.h"

namespace {

facedb::LittleFsPersist s_store;
facedb::FaceDb s_db(s_store);

}  // namespace

esp_err_t svc_facedb_init(void)
{
    return s_db.init(CONFIG_FACEDB_MAX_RECORDS);
}

esp_err_t svc_facedb_lookup(const int8_t *emb, float scale, svc_facedb_match_t *out)
{
    if (out == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    facedb::MatchResult result;
    const esp_err_t err = s_db.lookup(emb, scale, &result);
    if (err == ESP_OK) {
        out->employee_id = result.employee_id;
        out->template_idx = result.template_idx;
        out->score = result.score;
        // The table may move under a later enrol, so the name is copied out.
        strlcpy(out->name, result.name != nullptr ? result.name : "", sizeof(out->name));
    }
    return err;
}

esp_err_t svc_facedb_enroll(uint32_t employee_id, uint16_t template_idx, uint8_t quality, const int8_t *emb,
                            float scale, const char *name)
{
    return s_db.enroll(employee_id, template_idx, quality, emb, scale, name);
}

size_t svc_facedb_people(svc_facedb_person_t *out, size_t cap)
{
    return s_db.people(out, cap);
}

esp_err_t svc_facedb_remove(uint32_t employee_id)
{
    return s_db.remove(employee_id);
}

esp_err_t svc_facedb_remove_template(uint32_t employee_id, uint16_t template_idx)
{
    return s_db.remove_template(employee_id, template_idx);
}

esp_err_t svc_facedb_clear(bool keep_unreported)
{
    return s_db.clear(keep_unreported);
}

esp_err_t svc_facedb_seal_session(uint32_t employee_id, uint16_t first_idx, uint16_t count,
                                  int64_t session_ms)
{
    return s_db.seal_session(employee_id, first_idx, count, session_ms);
}

esp_err_t svc_facedb_keep_session(uint32_t employee_id, int64_t session_ms)
{
    return s_db.keep_session(employee_id, session_ms);
}

esp_err_t svc_facedb_next_unreported(svc_facedb_unreported_t *out)
{
    return s_db.next_unreported(out);
}

esp_err_t svc_facedb_mark_reported(uint32_t employee_id, uint16_t template_idx, int64_t session_ms)
{
    return s_db.mark_reported(employee_id, template_idx, session_ms);
}

esp_err_t svc_facedb_template(uint32_t employee_id, uint16_t template_idx, int8_t *emb, size_t cap,
                              float *scale, uint8_t *quality)
{
    return s_db.templet(employee_id, template_idx, emb, cap, scale, quality);
}

esp_err_t svc_facedb_persist(void)
{
    return s_db.persist();
}

size_t svc_facedb_count(void)
{
    return s_db.active();
}
