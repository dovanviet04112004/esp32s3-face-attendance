#include "facedb_internal.hpp"

#include <math.h>
#include <string.h>

#include "sdkconfig.h"

#if CONFIG_IDF_TARGET_ESP32S3
extern "C" int32_t facedb_dot_s8_esp32s3(const int8_t *query, const int8_t *tmpl, int32_t len);
#endif

namespace facedb {

namespace {

constexpr size_t kLanes = 4;
constexpr size_t kSimdAlign = 16;

// The PIE loads want the query on a 16-byte boundary, which a caller's buffer need not be.
alignas(kSimdAlign) int8_t s_query[STORAGE_EMBED_DIM];

bool live(const storage_face_record_t &rec) noexcept
{
    return (rec.flags & STORAGE_FACE_FLAG_ACTIVE) != 0 && (rec.flags & STORAGE_FACE_FLAG_DELETED) == 0;
}

int32_t dot_plain(const int8_t *a, const int8_t *b) noexcept
{
    int32_t acc[kLanes] = { 0, 0, 0, 0 };
    for (size_t i = 0; i < STORAGE_EMBED_DIM; i += kLanes) {
        acc[0] += static_cast<int32_t>(a[i]) * b[i];
        acc[1] += static_cast<int32_t>(a[i + 1]) * b[i + 1];
        acc[2] += static_cast<int32_t>(a[i + 2]) * b[i + 2];
        acc[3] += static_cast<int32_t>(a[i + 3]) * b[i + 3];
    }
    return acc[0] + acc[1] + acc[2] + acc[3];
}

int32_t dot_aligned_query(const int8_t *tmpl) noexcept
{
#if CONFIG_IDF_TARGET_ESP32S3
    return facedb_dot_s8_esp32s3(s_query, tmpl, STORAGE_EMBED_DIM);
#else
    return dot_plain(s_query, tmpl);
#endif
}

}  // namespace

uint32_t norm_sq(const int8_t *emb) noexcept
{
    return static_cast<uint32_t>(dot_plain(emb, emb));
}

MatchResult CosineLinearMatcher::best(const int8_t *emb, float scale) const noexcept
{
    (void)scale;
    MatchResult result = { 0, 0, -1.0f, false };
    const float query_sq = static_cast<float>(norm_sq(emb));
    if (query_sq == 0.0f) {
        return result;
    }
    memcpy(s_query, emb, STORAGE_EMBED_DIM);
    for (size_t i = 0; i < table_.count(); ++i) {
        const storage_face_record_t *rec = table_.record(i);
        if (!live(*rec) || table_.norm_sq(i) == 0) {
            continue;
        }
        // The per-record scale never enters: cosine measures angle, and a
        // positive factor cancels (KEHOACH 6.2.4).
        const float score = static_cast<float>(dot_aligned_query(rec->embedding)) /
                            sqrtf(query_sq * static_cast<float>(table_.norm_sq(i)));
        if (!result.found || score > result.score) {
            result = { rec->employee_id, rec->template_idx, score, true };
        }
    }
    return result;
}

}  // namespace facedb
