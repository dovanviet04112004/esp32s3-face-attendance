#include "net_ota.h"

#include <stdbool.h>
#include <string.h>

#include "app_err.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "sys_storage.h"
#include "mbedtls/md.h"

static const char *TAG = "net_ota";

#define HTTPS_PREFIX "https://"
#define SHA256_HEX_LEN 64
#define SHA256_BYTES 32
#define CHUNK_BYTES 2048
#define HTTP_TIMEOUT_MS 20000

static bool hex_digest(const char *text)
{
    if (text == NULL || strlen(text) != SHA256_HEX_LEN) {
        return false;
    }
    for (size_t i = 0; i < SHA256_HEX_LEN; ++i) {
        const char c = text[i];
        const bool digit = c >= '0' && c <= '9';
        const bool lower = c >= 'a' && c <= 'f';
        if (!digit && !lower) {
            return false;
        }
    }
    return true;
}

static void to_hex(const uint8_t *raw, char *out)
{
    static const char kDigits[] = "0123456789abcdef";
    for (size_t i = 0; i < SHA256_BYTES; ++i) {
        out[i * 2] = kDigits[raw[i] >> 4];
        out[i * 2 + 1] = kDigits[raw[i] & 0x0Fu];
    }
    out[SHA256_HEX_LEN] = '\0';
}

static void say(char *why, size_t cap, const char *text)
{
    if (why != NULL && cap > 0) {
        strlcpy(why, text, cap);
    }
}

// A manifest the kiosk cannot satisfy is cheaper to turn away at the door than
// to discover halfway through a partition.
static esp_err_t vet(const net_ota_image_t *image, const esp_partition_t *slot, bool unsized,
                     char *why, size_t cap)
{
    if (image == NULL || image->url == NULL || (slot == NULL && !unsized)) {
        say(why, cap, "manifest incomplete");
        return ESP_ERR_INVALID_ARG;
    }
    if (strncmp(image->url, HTTPS_PREFIX, strlen(HTTPS_PREFIX)) != 0) {
        say(why, cap, "url is not https");
        return ESP_ERR_INVALID_ARG;
    }
    if (!hex_digest(image->sha256)) {
        say(why, cap, "sha256 is not 64 hex digits");
        return ESP_ERR_INVALID_ARG;
    }
    if (image->size_bytes == 0 || (!unsized && image->size_bytes > slot->size)) {
        say(why, cap, "image does not fit the slot");
        return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
}

typedef esp_err_t (*sink_fn)(void *ctx, const void *data, size_t len);

static esp_err_t to_app_slot(void *ctx, const void *data, size_t len)
{
    return esp_ota_write(*(esp_ota_handle_t *)ctx, data, len);
}

static esp_err_t to_models_slot(void *ctx, const void *data, size_t len)
{
    (void)ctx;
    return sys_storage_models_stage_write(data, len);
}

static esp_err_t pull(esp_http_client_handle_t http, sink_fn sink, void *ctx, uint8_t *chunk,
                      size_t want, char *digest, char *why, size_t cap)
{
    mbedtls_md_context_t sha;
    mbedtls_md_init(&sha);
    if (mbedtls_md_setup(&sha, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0) != 0 ||
        mbedtls_md_starts(&sha) != 0) {
        mbedtls_md_free(&sha);
        say(why, cap, "no sha256 available");
        return ESP_FAIL;
    }
    size_t taken = 0;
    while (taken < want) {
        const int read = esp_http_client_read(http, (char *)chunk, (int)CHUNK_BYTES);
        if (read < 0) {
            say(why, cap, "connection dropped mid-image");
            mbedtls_md_free(&sha);
            return ESP_FAIL;
        }
        if (read == 0) {
            break;
        }
        mbedtls_md_update(&sha, chunk, (size_t)read);
        const esp_err_t written = sink(ctx, chunk, (size_t)read);
        if (written != ESP_OK) {
            say(why, cap, "the slot refused a write");
            mbedtls_md_free(&sha);
            return written;
        }
        taken += (size_t)read;
    }
    uint8_t raw[SHA256_BYTES];
    mbedtls_md_finish(&sha, raw);
    mbedtls_md_free(&sha);
    to_hex(raw, digest);
    if (taken != want) {
        say(why, cap, "body shorter than the manifest says");
        return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
}

static esp_http_client_handle_t dial(const net_ota_image_t *image, char *why, size_t cap)
{
    const esp_http_client_config_t cfg = {
        .url = image->url,
        .timeout_ms = HTTP_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .keep_alive_enable = false,
    };
    esp_http_client_handle_t http = esp_http_client_init(&cfg);
    if (http == NULL) {
        say(why, cap, "no room for a tls session");
        return NULL;
    }
    const char *stopped = NULL;
    if (esp_http_client_open(http, 0) != ESP_OK) {
        stopped = "the server did not answer";
    } else if (esp_http_client_fetch_headers(http) < 0) {
        stopped = "no headers from the server";
    } else if (esp_http_client_get_status_code(http) != HttpStatus_Ok) {
        stopped = "the server refused the url";
    }
    if (stopped != NULL) {
        say(why, cap, stopped);
        esp_http_client_cleanup(http);
        return NULL;
    }
    return http;
}

esp_err_t net_ota_models(const net_ota_image_t *image, char *why, size_t cap)
{
    const esp_err_t vetted = vet(image, NULL, true, why, cap);
    if (vetted != ESP_OK) {
        return vetted;
    }
    // The connection is opened first: erasing three megabytes for a url that
    // turns out to be dead costs seconds and the spare image with it.
    esp_http_client_handle_t http = dial(image, why, cap);
    if (http == NULL) {
        return ESP_FAIL;
    }
    uint8_t *chunk = heap_caps_malloc(CHUNK_BYTES, MALLOC_CAP_SPIRAM);
    esp_err_t err = chunk != NULL ? ESP_OK : ESP_ERR_NO_MEM;
    if (err != ESP_OK) {
        say(why, cap, "no room for a download buffer");
    } else {
        err = sys_storage_models_stage_begin(image->size_bytes);
        if (err != ESP_OK) {
            say(why, cap, "the spare slot would not take it");
        }
    }
    char digest[SHA256_HEX_LEN + 1] = { 0 };
    if (err == ESP_OK) {
        err = pull(http, to_models_slot, NULL, chunk, image->size_bytes, digest, why, cap);
    }
    esp_http_client_close(http);
    esp_http_client_cleanup(http);
    heap_caps_free(chunk);
    if (err == ESP_OK) {
        err = sys_storage_models_stage_end();
        if (err != ESP_OK) {
            say(why, cap, "the staged image has no usable header");
        }
    }
    if (err == ESP_OK && strcmp(digest, image->sha256) != 0) {
        ESP_LOGE(TAG, "digest %s, manifest %s", digest, image->sha256);
        say(why, cap, "sha256 does not match");
        err = ESP_ERR_INVALID_CRC;
    }
    if (err != ESP_OK) {
        sys_storage_models_stage_abort();
        return err;
    }
    // Only now: the slot the kiosk is running keeps serving until it reboots.
    err = sys_storage_models_activate();
    if (err != ESP_OK) {
        say(why, cap, "the slot would not arm");
    }
    return err;
}

esp_err_t net_ota_check(const net_ota_image_t *image, bool models, char *why, size_t cap)
{
    if (!models) {
        return vet(image, esp_ota_get_next_update_partition(NULL), false, why, cap);
    }
    const esp_err_t shaped = vet(image, NULL, true, why, cap);
    if (shaped != ESP_OK) {
        return shaped;
    }
    const size_t room = sys_storage_models_slot_bytes();
    if (room == 0 || image->size_bytes > room) {
        say(why, cap, "image does not fit the slot");
        return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
}

esp_err_t net_ota_firmware(const net_ota_image_t *image, char *why, size_t cap)
{
    const esp_partition_t *slot = esp_ota_get_next_update_partition(NULL);
    const esp_err_t vetted = vet(image, slot, false, why, cap);
    if (vetted != ESP_OK) {
        return vetted;
    }
    uint8_t *chunk = heap_caps_malloc(CHUNK_BYTES, MALLOC_CAP_SPIRAM);
    if (chunk == NULL) {
        say(why, cap, "no room for a download buffer");
        return ESP_ERR_NO_MEM;
    }
    const esp_http_client_config_t cfg = {
        .url = image->url,
        .timeout_ms = HTTP_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .keep_alive_enable = false,
    };
    esp_http_client_handle_t http = esp_http_client_init(&cfg);
    if (http == NULL) {
        heap_caps_free(chunk);
        say(why, cap, "no room for a tls session");
        return ESP_ERR_NO_MEM;
    }
    esp_err_t err = esp_http_client_open(http, 0);
    if (err != ESP_OK) {
        say(why, cap, "the server did not answer");
    } else if (esp_http_client_fetch_headers(http) < 0) {
        err = ESP_FAIL;
        say(why, cap, "no headers from the server");
    } else if (esp_http_client_get_status_code(http) != HttpStatus_Ok) {
        err = ESP_FAIL;
        say(why, cap, "the server refused the url");
    }
    esp_ota_handle_t writing = 0;
    char digest[SHA256_HEX_LEN + 1] = { 0 };
    if (err == ESP_OK) {
        err = esp_ota_begin(slot, image->size_bytes, &writing);
        if (err != ESP_OK) {
            say(why, cap, "the slot would not open");
        }
    }
    if (err == ESP_OK) {
        err = pull(http, to_app_slot, &writing, chunk, image->size_bytes, digest, why, cap);
    }
    esp_http_client_close(http);
    esp_http_client_cleanup(http);
    heap_caps_free(chunk);
    if (err != ESP_OK) {
        if (writing != 0) {
            esp_ota_abort(writing);
        }
        return err;
    }
    // The digest is checked while the slot is still inert: esp_ota_end is what
    // makes it bootable, so a mismatch never reaches the bootloader.
    if (strcmp(digest, image->sha256) != 0) {
        ESP_LOGE(TAG, "digest %s, manifest %s", digest, image->sha256);
        esp_ota_abort(writing);
        say(why, cap, "sha256 does not match");
        return ESP_ERR_INVALID_CRC;
    }
    err = esp_ota_end(writing);
    if (err != ESP_OK) {
        say(why, cap, "the image failed its own checks");
        return err;
    }
    err = esp_ota_set_boot_partition(slot);
    if (err != ESP_OK) {
        say(why, cap, "the slot would not arm");
        return err;
    }
    ESP_LOGW(TAG, "%s armed with %u bytes, reboot to run it", slot->label,
             (unsigned)image->size_bytes);
    return ESP_OK;
}

bool net_ota_on_trial(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state = ESP_OTA_IMG_VALID;
    if (running == NULL || esp_ota_get_state_partition(running, &state) != ESP_OK) {
        return false;
    }
    return state == ESP_OTA_IMG_PENDING_VERIFY;
}

esp_err_t net_ota_mark_valid(void)
{
    if (!net_ota_on_trial()) {
        return ESP_ERR_INVALID_STATE;
    }
    const esp_err_t marked = esp_ota_mark_app_valid_cancel_rollback();
    ESP_LOGW(TAG, "this build is keeping the slot: %s", esp_err_to_name(marked));
    return marked;
}
