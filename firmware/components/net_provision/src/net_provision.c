#include "net_provision.h"

#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_random.h"
#include "mbedtls/base64.h"
#include "sys_storage.h"

static const char *TAG = "net_provision";

#define REGISTER_PATH "/devices/register"
#define CHECK_PATH "/devices/me"
#define RENEW_PATH "/devices/me/token"
#define BEARER "Bearer "
#define URL_CAP 160
#define ANSWER_CAP 1024
#define TICKET_CAP 1024
#define CLAIMS_CAP 512
#define HTTP_TIMEOUT_MS 15000
#define JITTER_PERCENT 20
#define MS_PER_S 1000u
#define S_PER_DAY 86400u
#define HTTP_ACCEPTED 202                 // HttpStatus_Code stops short of it
#define NVS_CLAIM "claim"
#define CLAIM_DIGITS 6
#define CLAIM_SPACE 1000000u
#define CLAIM_FAIR_LIMIT 4294000000u      // largest multiple of CLAIM_SPACE in 32 bits

typedef struct {
    int status;                           // 0 when nothing came back
    char *body;
    size_t cap;
    size_t len;
} answer_t;

static esp_err_t exchange(esp_http_client_method_t method, const char *path, const char *auth,
                          const char *body, answer_t *out)
{
    char url[URL_CAP];
    if (snprintf(url, sizeof(url), "%s%s", CONFIG_NET_PROVISION_API_URL, path) >=
        (int)sizeof(url)) {
        return ESP_ERR_INVALID_SIZE;
    }
    const esp_http_client_config_t cfg = {
        .url = url,
        .method = method,
        .timeout_ms = HTTP_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .keep_alive_enable = false,
    };
    esp_http_client_handle_t http = esp_http_client_init(&cfg);
    if (http == NULL) {
        return ESP_ERR_NO_MEM;
    }
    if (auth != NULL) {
        esp_http_client_set_header(http, "Authorization", auth);
    }
    const int sending = body != NULL ? (int)strlen(body) : 0;
    if (body != NULL) {
        esp_http_client_set_header(http, "Content-Type", "application/json");
    }
    esp_err_t err = esp_http_client_open(http, sending);
    if (err == ESP_OK && sending > 0 && esp_http_client_write(http, body, sending) != sending) {
        err = ESP_FAIL;
    }
    if (err == ESP_OK && esp_http_client_fetch_headers(http) < 0) {
        err = ESP_FAIL;
    }
    if (err == ESP_OK) {
        out->status = esp_http_client_get_status_code(http);
        int got = 0;
        while (out->len + 1 < out->cap &&
               (got = esp_http_client_read(http, out->body + out->len,
                                           (int)(out->cap - out->len - 1))) > 0) {
            out->len += (size_t)got;
        }
        out->body[out->len] = '\0';
    }
    esp_http_client_close(http);
    esp_http_client_cleanup(http);
    return err;
}

static bool answer_open(answer_t *answer)
{
    *answer = (answer_t){ .cap = ANSWER_CAP };
    answer->body = heap_caps_calloc(1, ANSWER_CAP, MALLOC_CAP_SPIRAM);
    return answer->body != NULL;
}

static bool claim_shape(const char *code)
{
    if (strlen(code) != CLAIM_DIGITS) {
        return false;
    }
    for (size_t i = 0; i < CLAIM_DIGITS; ++i) {
        if (code[i] < '0' || code[i] > '9') {
            return false;
        }
    }
    return true;
}

esp_err_t net_provision_claim(char *out, size_t cap)
{
    if (out == NULL || cap < CLAIM_DIGITS + 1) {
        return ESP_ERR_INVALID_SIZE;
    }
    if (sys_storage_get_str(STORAGE_NS_DEVICE, NVS_CLAIM, out, cap) == ESP_OK && claim_shape(out)) {
        return ESP_OK;
    }
    uint32_t draw = esp_random();
    // Rejecting the top sliver keeps every code equally likely (KEHOACH 7.3).
    while (draw >= CLAIM_FAIR_LIMIT) {
        draw = esp_random();
    }
    snprintf(out, cap, "%06" PRIu32, draw % CLAIM_SPACE);
    return sys_storage_set_str(STORAGE_NS_DEVICE, NVS_CLAIM, out);
}

static char *register_body(void)
{
    char device_id[STORAGE_DEVICE_ID_CAP] = { 0 };
    char claim[CLAIM_DIGITS + 1] = { 0 };
    if (sys_storage_device_id(device_id, sizeof(device_id)) != ESP_OK ||
        net_provision_claim(claim, sizeof(claim)) != ESP_OK) {
        return NULL;
    }
    cJSON *ask = cJSON_CreateObject();
    if (ask == NULL) {
        return NULL;
    }
    cJSON_AddStringToObject(ask, "deviceId", device_id);
    cJSON_AddStringToObject(ask, "bootstrapToken", CONFIG_NET_PROVISION_BOOTSTRAP_TOKEN);
    cJSON_AddStringToObject(ask, "fwVersion", esp_app_get_description()->version);
    cJSON_AddStringToObject(ask, "claimCode", claim);
    char *text = cJSON_PrintUnformatted(ask);
    cJSON_Delete(ask);
    return text;
}

// The ticket goes in first: an exp without its ticket means nothing, a ticket without its exp still logs in.
static bool keep_ticket(const char *reply)
{
    cJSON *root = cJSON_Parse(reply);
    const cJSON *token = cJSON_GetObjectItemCaseSensitive(root, "token");
    const bool usable = cJSON_IsString(token) && token->valuestring[0] != '\0' &&
                        strlen(token->valuestring) < TICKET_CAP;
    bool kept = usable && sys_storage_set_str(STORAGE_NS_DEVICE, STORAGE_KEY_TICKET,
                                              token->valuestring) == ESP_OK;
    uint32_t exp = 0;
    if (kept && net_provision_ticket_exp(token->valuestring, &exp) == ESP_OK) {
        sys_storage_set_u32(STORAGE_NS_DEVICE, STORAGE_KEY_TICKET_EXP, exp);
    }
    cJSON_Delete(root);
    if (!kept) {
        ESP_LOGE(TAG, "a 200 without a ticket this kiosk could keep");
    }
    return kept;
}

// A code typed wrong too often is dead; the next ask carries a fresh one (KEHOACH 7.3).
static void read_waiting(const char *reply, uint32_t *poll_s)
{
    cJSON *root = cJSON_Parse(reply);
    if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(root, "claimRenew"))) {
        ESP_LOGW(TAG, "claim code spent, showing a new one");
        sys_storage_erase_key(STORAGE_NS_DEVICE, NVS_CLAIM);
    }
    const cJSON *pace = cJSON_GetObjectItemCaseSensitive(root, "pollIntervalS");
    if (poll_s != NULL && cJSON_IsNumber(pace) && pace->valuedouble >= 1 &&
        pace->valuedouble < (double)UINT32_MAX) {
        *poll_s = (uint32_t)pace->valuedouble;
    }
    cJSON_Delete(root);
}

net_provision_answer_t net_provision_register(uint32_t *poll_s)
{
    if (poll_s != NULL) {
        *poll_s = 0;
    }
    if (CONFIG_NET_PROVISION_BOOTSTRAP_TOKEN[0] == '\0') {
        ESP_LOGW(TAG, "this build carries no batch token, it cannot register");
        return NET_PROVISION_DISABLED;
    }
    char *body = register_body();
    answer_t answer;
    if (body == NULL || !answer_open(&answer)) {
        cJSON_free(body);
        return NET_PROVISION_UNREACHABLE;
    }
    const esp_err_t sent = exchange(HTTP_METHOD_POST, REGISTER_PATH, NULL, body, &answer);
    cJSON_free(body);
    net_provision_answer_t said = NET_PROVISION_UNREACHABLE;
    if (sent != ESP_OK) {
        ESP_LOGW(TAG, "register: %s", esp_err_to_name(sent));
    } else if (answer.status == HttpStatus_Ok) {
        said = keep_ticket(answer.body) ? NET_PROVISION_GRANTED : NET_PROVISION_UNREACHABLE;
        if (said == NET_PROVISION_GRANTED) {
            sys_storage_erase_key(STORAGE_NS_DEVICE, NVS_CLAIM);
        }
    } else if (answer.status == HTTP_ACCEPTED) {
        said = NET_PROVISION_WAITING;
        read_waiting(answer.body, poll_s);
    } else if (answer.status == HttpStatus_Unauthorized) {
        said = NET_PROVISION_REFUSED;
    }
    ESP_LOGI(TAG, "register answered %d", answer.status);
    heap_caps_free(answer.body);
    return said;
}

// Sets *held false when NVS has no ticket to present, which is an answer and not a failure.
static char *bearer_header(bool *held)
{
    *held = true;
    char *auth = heap_caps_calloc(1, sizeof(BEARER) + TICKET_CAP, MALLOC_CAP_SPIRAM);
    if (auth == NULL) {
        return NULL;
    }
    strlcpy(auth, BEARER, sizeof(BEARER));
    const size_t head = strlen(BEARER);
    if (sys_storage_get_str(STORAGE_NS_DEVICE, STORAGE_KEY_TICKET, auth + head, TICKET_CAP) !=
            ESP_OK ||
        auth[head] == '\0') {
        *held = false;
        heap_caps_free(auth);
        return NULL;
    }
    return auth;
}

static net_provision_answer_t ask_with_ticket(esp_http_client_method_t method, const char *path,
                                              bool stores_reply)
{
    bool held = false;
    char *auth = bearer_header(&held);
    answer_t answer;
    if (auth == NULL || !answer_open(&answer)) {
        heap_caps_free(auth);
        return held ? NET_PROVISION_UNREACHABLE : NET_PROVISION_REFUSED;
    }
    const esp_err_t sent = exchange(method, path, auth, NULL, &answer);
    heap_caps_free(auth);
    net_provision_answer_t said = NET_PROVISION_UNREACHABLE;
    if (sent == ESP_OK && answer.status == HttpStatus_Ok) {
        said = !stores_reply || keep_ticket(answer.body) ? NET_PROVISION_GRANTED
                                                         : NET_PROVISION_UNREACHABLE;
    } else if (sent == ESP_OK && answer.status == HttpStatus_Unauthorized) {
        said = NET_PROVISION_REFUSED;
    }
    ESP_LOGI(TAG, "%s answered %d", path, answer.status);
    heap_caps_free(answer.body);
    return said;
}

net_provision_answer_t net_provision_check(void)
{
    return ask_with_ticket(HTTP_METHOD_GET, CHECK_PATH, false);
}

net_provision_answer_t net_provision_renew(void)
{
    return ask_with_ticket(HTTP_METHOD_POST, RENEW_PATH, true);
}

esp_err_t net_provision_held_exp(uint32_t *exp)
{
    if (exp == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    return sys_storage_get_u32(STORAGE_NS_DEVICE, STORAGE_KEY_TICKET_EXP, exp) == ESP_OK
               ? ESP_OK
               : ESP_ERR_NOT_FOUND;
}

bool net_provision_renew_due(uint32_t exp, int64_t now_ms)
{
    const uint64_t window_s = (uint64_t)CONFIG_NET_PROVISION_RENEW_BEFORE_DAYS * S_PER_DAY;
    return exp != 0 && now_ms > 0 && (uint64_t)now_ms / MS_PER_S + window_s >= exp;
}

esp_err_t net_provision_forget(void)
{
    sys_storage_erase_key(STORAGE_NS_DEVICE, NVS_CLAIM);
    sys_storage_erase_key(STORAGE_NS_DEVICE, STORAGE_KEY_TICKET_EXP);
    return sys_storage_erase_key(STORAGE_NS_DEVICE, STORAGE_KEY_TICKET);
}

esp_err_t net_provision_ticket_exp(const char *ticket, uint32_t *exp)
{
    const char *start = ticket != NULL ? strchr(ticket, '.') : NULL;
    const char *end = start != NULL ? strchr(start + 1, '.') : NULL;
    const size_t len = end != NULL ? (size_t)(end - start - 1) : 0;
    if (exp == NULL || len == 0 || len + 4 > CLAIMS_CAP) {
        return ESP_ERR_INVALID_ARG;
    }
    unsigned char coded[CLAIMS_CAP];
    for (size_t i = 0; i < len; ++i) {
        const char c = start[1 + i];
        coded[i] = c == '-' ? '+' : (c == '_' ? '/' : (unsigned char)c);
    }
    size_t padded = len;
    while (padded % 4 != 0) {
        coded[padded++] = '=';
    }
    unsigned char plain[CLAIMS_CAP];
    size_t plain_len = 0;
    if (mbedtls_base64_decode(plain, sizeof(plain) - 1, &plain_len, coded, padded) != 0) {
        return ESP_ERR_INVALID_ARG;
    }
    cJSON *claims = cJSON_ParseWithLength((const char *)plain, plain_len);
    const cJSON *field = cJSON_GetObjectItemCaseSensitive(claims, "exp");
    const bool found = cJSON_IsNumber(field) && field->valuedouble > 0 &&
                       field->valuedouble < (double)UINT32_MAX;
    if (found) {
        *exp = (uint32_t)field->valuedouble;
    }
    cJSON_Delete(claims);
    return found ? ESP_OK : ESP_ERR_INVALID_ARG;
}

static uint32_t jittered_ms(uint64_t base_ms, uint32_t random)
{
    const uint64_t spread = base_ms * JITTER_PERCENT / 100;
    return (uint32_t)(base_ms - spread + (uint64_t)random % (2 * spread + 1));
}

uint32_t net_provision_poll_ms(uint32_t poll_s, uint32_t random)
{
    uint32_t held_s = poll_s > CONFIG_NET_PROVISION_POLL_FLOOR_S ? poll_s
                                                                 : CONFIG_NET_PROVISION_POLL_FLOOR_S;
    held_s = held_s < CONFIG_NET_PROVISION_WAIT_MAX_S ? held_s : CONFIG_NET_PROVISION_WAIT_MAX_S;
    return jittered_ms((uint64_t)held_s * MS_PER_S, random);
}

uint32_t net_provision_wait_ms(uint32_t attempt, uint32_t random)
{
    const uint64_t ceiling = (uint64_t)CONFIG_NET_PROVISION_WAIT_MAX_S * MS_PER_S;
    uint64_t base = (uint64_t)CONFIG_NET_PROVISION_WAIT_MIN_S * MS_PER_S;
    for (uint32_t i = 0; i < attempt && base < ceiling; ++i) {
        base *= 2;
    }
    return jittered_ms(base < ceiling ? base : ceiling, random);
}
