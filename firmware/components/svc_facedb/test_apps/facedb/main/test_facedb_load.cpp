#include <string.h>

#include "facedb_internal.hpp"
#include "storage_format.h"
#include "unity.h"

namespace {

constexpr size_t kCapacity = 4;
constexpr uint16_t kFutureFormat = STORAGE_FACES_VER + 1;
constexpr uint32_t kEmployee = 9;

class ScriptedStore final : public facedb::IPersist {
public:
    esp_err_t answer = ESP_OK;
    uint16_t format_ver = STORAGE_FACES_VER;
    int saves = 0;

    esp_err_t load(uint8_t *image, size_t cap, size_t *len) noexcept override
    {
        if (answer != ESP_OK) {
            return answer;
        }
        storage_file_header_t head = {};
        head.magic = STORAGE_FACES_MAGIC;
        head.format_ver = format_ver;
        head.record_size = sizeof(storage_face_record_t);
        TEST_ASSERT_GREATER_OR_EQUAL(sizeof(head), cap);
        memcpy(image, &head, sizeof(head));
        *len = sizeof(head);
        return ESP_OK;
    }

    esp_err_t save(const uint8_t *, size_t) noexcept override
    {
        ++saves;
        return ESP_OK;
    }
};

void opens_empty_and_says(ScriptedStore &store, esp_err_t why)
{
    facedb::FaceDb db(store);
    TEST_ASSERT_EQUAL(ESP_OK, db.init(kCapacity));
    TEST_ASSERT_EQUAL(why, db.load_error());
    TEST_ASSERT_EQUAL(0, db.active());
    TEST_ASSERT_EQUAL(0, store.saves);
    int8_t emb[STORAGE_EMBED_DIM] = { 1 };
    TEST_ASSERT_EQUAL(ESP_OK, db.enroll(kEmployee, 0, 1, emb, 1.0f, "", facedb::Writer::Server));
    TEST_ASSERT_EQUAL(1, db.active());
}

}  // namespace

TEST_CASE("a table never written opens empty and says there was no file", "[svc_facedb]")
{
    ScriptedStore store;
    store.answer = ESP_ERR_NOT_FOUND;
    opens_empty_and_says(store, ESP_ERR_NOT_FOUND);
}

TEST_CASE("a file that fails its check or outgrows the table opens empty and says why", "[svc_facedb]")
{
    const esp_err_t answers[] = { ESP_ERR_INVALID_CRC, ESP_ERR_INVALID_SIZE, ESP_FAIL };
    for (const esp_err_t answer : answers) {
        ScriptedStore store;
        store.answer = answer;
        opens_empty_and_says(store, answer);
    }
}

TEST_CASE("a file from a newer firmware opens empty, untouched, and names its format", "[svc_facedb]")
{
    ScriptedStore store;
    store.format_ver = kFutureFormat;
    opens_empty_and_says(store, ESP_ERR_INVALID_VERSION);
}

TEST_CASE("a table this firmware reads opens with nothing to report", "[svc_facedb]")
{
    ScriptedStore store;
    facedb::FaceDb db(store);
    TEST_ASSERT_EQUAL(ESP_OK, db.init(kCapacity));
    TEST_ASSERT_EQUAL(ESP_OK, db.load_error());
    TEST_ASSERT_EQUAL(0, store.saves);
}
