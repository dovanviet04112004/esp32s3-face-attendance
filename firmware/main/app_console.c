#include "app_console.h"

#if CONFIG_APP_CONSOLE

#include <string.h>

#include "app_err.h"
#include "argtable3/argtable3.h"
#include "esp_console.h"
#include "esp_log.h"
#include "sys_storage.h"

static const char *TAG = "app_console";

#define VALUE_CAP 192
#define PROMPT "kiosk> "

static struct {
    struct arg_str *ns;
    struct arg_str *key;
    struct arg_str *value;
    struct arg_end *end;
} s_set;

static struct {
    struct arg_str *ns;
    struct arg_str *key;
    struct arg_end *end;
} s_get;

static int set_cmd(int argc, char **argv)
{
    if (arg_parse(argc, argv, (void **)&s_set) != 0) {
        arg_print_errors(stderr, s_set.end, argv[0]);
        return 1;
    }
    const esp_err_t err =
        sys_storage_set_str(s_set.ns->sval[0], s_set.key->sval[0], s_set.value->sval[0]);
    // The value is echoed back as a length so a password never reaches the log.
    ESP_LOGI(TAG, "set %s/%s to %u chars: %s", s_set.ns->sval[0], s_set.key->sval[0],
             (unsigned)strlen(s_set.value->sval[0]), esp_err_to_name(err));
    return err == ESP_OK ? 0 : 1;
}

// The secrets of KEHOACH 6.2.1, which read back as a length and never as a value.
static const char *const kSecretKeys[] = { "pass", "jwt", "mqtt_pass" };

static bool is_secret(const char *key)
{
    for (size_t i = 0; i < sizeof(kSecretKeys) / sizeof(kSecretKeys[0]); ++i) {
        if (strcmp(key, kSecretKeys[i]) == 0) { return true; }
    }
    return false;
}

static int get_cmd(int argc, char **argv)
{
    if (arg_parse(argc, argv, (void **)&s_get) != 0) {
        arg_print_errors(stderr, s_get.end, argv[0]);
        return 1;
    }
    char value[VALUE_CAP] = { 0 };
    const char *ns = s_get.ns->sval[0];
    const char *key = s_get.key->sval[0];
    const esp_err_t err = sys_storage_get_str(ns, key, value, sizeof(value));
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "get %s/%s: %s", ns, key, esp_err_to_name(err));
        return 1;
    }
    if (is_secret(key)) {
        ESP_LOGI(TAG, "%s/%s holds %u chars", ns, key, (unsigned)strlen(value));
        return 0;
    }
    ESP_LOGI(TAG, "%s/%s = %s", ns, key, value);
    return 0;
}

static void register_commands(void)
{
    s_set.ns = arg_str1(NULL, NULL, "<ns>", "namespace of KEHOACH 6.2.1");
    s_set.key = arg_str1(NULL, NULL, "<key>", "key inside that namespace");
    s_set.value = arg_str1(NULL, NULL, "<value>", "string to store");
    s_set.end = arg_end(3);
    const esp_console_cmd_t set = {
        .command = "set",
        .help = "Write one NVS string",
        .argtable = &s_set,
        .func = set_cmd,
    };
    ESP_ERROR_CHECK(esp_console_cmd_register(&set));

    s_get.ns = arg_str1(NULL, NULL, "<ns>", "namespace of KEHOACH 6.2.1");
    s_get.key = arg_str1(NULL, NULL, "<key>", "key inside that namespace");
    s_get.end = arg_end(2);
    const esp_console_cmd_t get = {
        .command = "get",
        .help = "Read one NVS string",
        .argtable = &s_get,
        .func = get_cmd,
    };
    ESP_ERROR_CHECK(esp_console_cmd_register(&get));
}

esp_err_t app_console_start(void)
{
    esp_console_repl_t *repl = NULL;
    esp_console_repl_config_t config = ESP_CONSOLE_REPL_CONFIG_DEFAULT();
    config.prompt = PROMPT;
    config.max_cmdline_length = VALUE_CAP + VALUE_CAP;
    // Leaving history unsaved is what keeps a typed password off the flash.
    config.history_save_path = NULL;

    esp_console_dev_usb_serial_jtag_config_t port =
        ESP_CONSOLE_DEV_USB_SERIAL_JTAG_CONFIG_DEFAULT();
    APP_RETURN_ON_ERR(esp_console_new_repl_usb_serial_jtag(&port, &config, &repl), TAG, "repl");
    esp_console_register_help_command();
    register_commands();
    APP_RETURN_ON_ERR(esp_console_start_repl(repl), TAG, "start");
    ESP_LOGW(TAG, "provisioning console up: this build must never ship");
    return ESP_OK;
}

#else

esp_err_t app_console_start(void)
{
    return ESP_ERR_NOT_SUPPORTED;
}

#endif
