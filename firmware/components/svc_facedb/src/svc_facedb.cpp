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

esp_err_t svc_facedb_remove(uint32_t employee_id)
{
    return s_db.remove(employee_id);
}

esp_err_t svc_facedb_persist(void)
{
    return s_db.persist();
}

size_t svc_facedb_count(void)
{
    return s_db.active();
}
