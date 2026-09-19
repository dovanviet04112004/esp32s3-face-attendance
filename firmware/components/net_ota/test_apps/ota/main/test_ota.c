#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "esp_netif.h"
#include "esp_timer.h"
#include "net_ota.h"
#include "sys_storage.h"
#include "unity.h"

#define DIGEST_OK "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
#define DIGEST_SHORT "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde"
#define DIGEST_UPPER "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef"
#define DIGEST_GAPPED "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg"
#define URL_TLS "https://example.invalid/kiosk.bin"
#define URL_PLAIN "http://example.invalid/kiosk.bin"
// 192.0.2.0/24 is reserved for documentation (RFC 5737), so no network routes it.
#define URL_DEAD "https://192.0.2.1/models.bin"
#define SMALL_IMAGE_BYTES 65536
#define CHEAP_REFUSAL_US 50000
#define NARROW_CAP 4

static net_ota_image_t manifest(const char *url, const char *digest, size_t size_bytes)
{
    const net_ota_image_t image = { .url = url, .sha256 = digest, .size_bytes = size_bytes };
    return image;
}

static void storage_up(void)
{
    const esp_err_t err = sys_storage_init();
    TEST_ASSERT_TRUE(err == ESP_OK || err == ESP_ERR_INVALID_STATE);
}

TEST_CASE("a manifest with no url is refused whichever slot it names", "[net_ota]")
{
    char why[NET_OTA_WHY_CAP] = { 0 };
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, net_ota_check(NULL, false, why, sizeof(why)));
    TEST_ASSERT_EQUAL_STRING("manifest incomplete", why);
    const net_ota_image_t headless = manifest(NULL, DIGEST_OK, SMALL_IMAGE_BYTES);
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, net_ota_check(&headless, true, why, sizeof(why)));
    TEST_ASSERT_EQUAL_STRING("manifest incomplete", why);
}

TEST_CASE("plain http is refused for firmware and for models alike", "[net_ota]")
{
    storage_up();
    const net_ota_image_t plain = manifest(URL_PLAIN, DIGEST_OK, SMALL_IMAGE_BYTES);
    char why[NET_OTA_WHY_CAP] = { 0 };
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, net_ota_check(&plain, false, why, sizeof(why)));
    TEST_ASSERT_EQUAL_STRING("url is not https", why);
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, net_ota_check(&plain, true, why, sizeof(why)));
    TEST_ASSERT_EQUAL_STRING("url is not https", why);
}

TEST_CASE("a digest that is not 64 lowercase hex digits is refused", "[net_ota]")
{
    char why[NET_OTA_WHY_CAP] = { 0 };
    const char *shapes[] = { NULL, "", DIGEST_SHORT, DIGEST_UPPER, DIGEST_GAPPED };
    for (size_t i = 0; i < sizeof(shapes) / sizeof(shapes[0]); ++i) {
        const net_ota_image_t image = manifest(URL_TLS, shapes[i], SMALL_IMAGE_BYTES);
        TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, net_ota_check(&image, false, why, sizeof(why)));
        TEST_ASSERT_EQUAL_STRING("sha256 is not 64 hex digits", why);
    }
}

TEST_CASE("one size fills the models slot and overflows the firmware slot", "[net_ota]")
{
    storage_up();
    const size_t models_room = sys_storage_models_slot_bytes();
    TEST_ASSERT_GREATER_THAN_UINT(0, models_room);
    printf("the spare models slot holds %u B\n", (unsigned)models_room);

    char why[NET_OTA_WHY_CAP] = { 0 };
    const net_ota_image_t whole_slot = manifest(URL_TLS, DIGEST_OK, models_room);
    TEST_ASSERT_EQUAL(ESP_OK, net_ota_check(&whole_slot, true, why, sizeof(why)));
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_SIZE, net_ota_check(&whole_slot, false, why, sizeof(why)));
    TEST_ASSERT_EQUAL_STRING("image does not fit the slot", why);

    const net_ota_image_t past_slot = manifest(URL_TLS, DIGEST_OK, models_room + 1);
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_SIZE, net_ota_check(&past_slot, true, why, sizeof(why)));

    const net_ota_image_t empty = manifest(URL_TLS, DIGEST_OK, 0);
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_SIZE, net_ota_check(&empty, false, why, sizeof(why)));
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_SIZE, net_ota_check(&empty, true, why, sizeof(why)));
}

TEST_CASE("a manifest that passes leaves the reason buffer untouched", "[net_ota]")
{
    storage_up();
    const net_ota_image_t image = manifest(URL_TLS, DIGEST_OK, SMALL_IMAGE_BYTES);
    char why[NET_OTA_WHY_CAP] = { 0 };
    const int64_t t0 = esp_timer_get_time();
    TEST_ASSERT_EQUAL(ESP_OK, net_ota_check(&image, false, why, sizeof(why)));
    TEST_ASSERT_EQUAL(ESP_OK, net_ota_check(&image, true, why, sizeof(why)));
    const int spent_us = (int)(esp_timer_get_time() - t0);
    printf("two manifests vetted in %d us\n", spent_us);
    TEST_ASSERT_LESS_THAN(CHEAP_REFUSAL_US, spent_us);
    TEST_ASSERT_EQUAL_STRING("", why);
}

TEST_CASE("the reason fits whatever buffer the caller brought", "[net_ota]")
{
    const net_ota_image_t plain = manifest(URL_PLAIN, DIGEST_OK, SMALL_IMAGE_BYTES);
    char narrow[NARROW_CAP];
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, net_ota_check(&plain, false, narrow, sizeof(narrow)));
    TEST_ASSERT_EQUAL_STRING("url", narrow);
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, net_ota_check(&plain, false, NULL, 0));
}

TEST_CASE("a refused manifest costs neither a connection nor an erase", "[net_ota]")
{
    storage_up();
    const uint8_t slot = sys_storage_models_slot();
    const net_ota_image_t plain = manifest(URL_PLAIN, DIGEST_OK, SMALL_IMAGE_BYTES);
    char why[NET_OTA_WHY_CAP] = { 0 };
    const int64_t t0 = esp_timer_get_time();
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, net_ota_models(&plain, why, sizeof(why)));
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, net_ota_firmware(&plain, why, sizeof(why)));
    const int spent_us = (int)(esp_timer_get_time() - t0);
    printf("both downloads gave up in %d us, erasing three megabytes takes seconds\n", spent_us);
    TEST_ASSERT_LESS_THAN(CHEAP_REFUSAL_US, spent_us);
    TEST_ASSERT_EQUAL_UINT8(slot, sys_storage_models_slot());
    // A staged slot left open is what an abandoned erase would show up as here.
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, sys_storage_models_stage_write("x", 1));
}

TEST_CASE("an unreachable host is named and the spare slot is left alone", "[net_ota]")
{
    storage_up();
    const uint8_t slot = sys_storage_models_slot();
    const net_ota_image_t image = manifest(URL_DEAD, DIGEST_OK, SMALL_IMAGE_BYTES);
    char why[NET_OTA_WHY_CAP] = { 0 };

    int64_t t0 = esp_timer_get_time();
    TEST_ASSERT_NOT_EQUAL(ESP_OK, net_ota_models(&image, why, sizeof(why)));
    printf("models gave up after %d ms: %s\n", (int)((esp_timer_get_time() - t0) / 1000), why);
    TEST_ASSERT_EQUAL_STRING("the server did not answer", why);

    t0 = esp_timer_get_time();
    TEST_ASSERT_NOT_EQUAL(ESP_OK, net_ota_firmware(&image, why, sizeof(why)));
    printf("firmware gave up after %d ms: %s\n", (int)((esp_timer_get_time() - t0) / 1000), why);
    TEST_ASSERT_EQUAL_STRING("the server did not answer", why);

    TEST_ASSERT_EQUAL_UINT8(slot, sys_storage_models_slot());
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, sys_storage_models_stage_write("x", 1));
}

TEST_CASE("a slot is signed for once and the second signature is refused", "[net_ota]")
{
    const bool trial = net_ota_on_trial();
    printf("this boot runs %s\n", trial ? "a fresh image on trial" : "a settled image");
    TEST_ASSERT_EQUAL(trial ? ESP_OK : ESP_ERR_INVALID_STATE, net_ota_mark_valid());
    TEST_ASSERT_FALSE(net_ota_on_trial());
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, net_ota_mark_valid());
}

void app_main(void)
{
    // esp_http_client reaches straight into lwip, which asserts on a missing
    // mailbox rather than returning, so the stack comes up with no route on it.
    ESP_ERROR_CHECK(esp_netif_init());
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
