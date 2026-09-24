#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "lwip/netdb.h"

#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "net_provision.h"
#include "net_wifi.h"
#include "sys_storage.h"
#include "unity.h"

#define JOIN_TIMEOUT_MS 20000
#define TICKET_CAP 1024
#define MS_PER_S 1000u
#define JITTER_PERCENT 20u
// Claims {"deviceId":"kiosk-2884859fd3c8","iat":1790000000,"exp":1797776000}, unpadded.
#define TICKET_PLAIN                                                                             \
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."                                                      \
    "eyJkZXZpY2VJZCI6Imtpb3NrLTI4ODQ4NTlmZDNjOCIsImlhdCI6MTc5MDAwMDAwMCwiZXhwIjoxNzk3Nzc2MDAwfQ" \
    ".c2lnbmF0dXJl"
// Claims {"deviceId":"k?>~~~","exp":1797776001}: the body carries both url-safe characters.
#define TICKET_URLSAFE                                                                           \
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkZXZpY2VJZCI6Ims_Pn5-fiIsImV4cCI6MTc5Nzc3NjAwMX0" \
    ".c2lnbmF0dXJl"
#define TICKET_NO_EXP "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkZXZpY2VJZCI6IngifQ.sig"

static uint32_t spread_of(uint32_t base_ms)
{
    return base_ms * JITTER_PERCENT / 100;
}

TEST_CASE("the first wait sits within a fifth of the floor", "[provision]")
{
    const uint32_t floor_ms = CONFIG_NET_PROVISION_WAIT_MIN_S * MS_PER_S;
    TEST_ASSERT_EQUAL_UINT32(floor_ms - spread_of(floor_ms), net_provision_wait_ms(0, 0));
    TEST_ASSERT_EQUAL_UINT32(floor_ms + spread_of(floor_ms),
                             net_provision_wait_ms(0, 2 * spread_of(floor_ms)));
}

TEST_CASE("each wait doubles the last until the ceiling holds it", "[provision]")
{
    const uint32_t floor_ms = CONFIG_NET_PROVISION_WAIT_MIN_S * MS_PER_S;
    const uint32_t ceiling_ms = CONFIG_NET_PROVISION_WAIT_MAX_S * MS_PER_S;
    const uint32_t middle = spread_of(2 * floor_ms);
    TEST_ASSERT_EQUAL_UINT32(2 * floor_ms, net_provision_wait_ms(1, middle));
    TEST_ASSERT_EQUAL_UINT32(ceiling_ms, net_provision_wait_ms(40, spread_of(ceiling_ms)));
    TEST_ASSERT_EQUAL_UINT32(ceiling_ms, net_provision_wait_ms(UINT32_MAX, spread_of(ceiling_ms)));
}

TEST_CASE("no wait ever leaves the jittered ceiling", "[provision]")
{
    const uint32_t ceiling_ms = CONFIG_NET_PROVISION_WAIT_MAX_S * MS_PER_S;
    for (uint32_t attempt = 0; attempt < 64; ++attempt) {
        const uint32_t waited = net_provision_wait_ms(attempt, UINT32_MAX - attempt);
        TEST_ASSERT_LESS_OR_EQUAL_UINT32(ceiling_ms + spread_of(ceiling_ms), waited);
    }
}

TEST_CASE("exp is read from the ticket's own claims", "[provision]")
{
    uint32_t exp = 0;
    TEST_ASSERT_EQUAL(ESP_OK, net_provision_ticket_exp(TICKET_PLAIN, &exp));
    TEST_ASSERT_EQUAL_UINT32(1797776000u, exp);
    TEST_ASSERT_EQUAL(ESP_OK, net_provision_ticket_exp(TICKET_URLSAFE, &exp));
    TEST_ASSERT_EQUAL_UINT32(1797776001u, exp);
}

TEST_CASE("a ticket with no exp or no body is refused", "[provision]")
{
    uint32_t exp = 7;
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, net_provision_ticket_exp(TICKET_NO_EXP, &exp));
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, net_provision_ticket_exp("no-dots-at-all", &exp));
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, net_provision_ticket_exp("a..b", &exp));
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_ARG, net_provision_ticket_exp(NULL, &exp));
    TEST_ASSERT_EQUAL_UINT32(7u, exp);
}

// Several cases need storage, and a second init answers INVALID_STATE.
static void storage_up(void)
{
    const esp_err_t up = sys_storage_init();
    TEST_ASSERT_TRUE(up == ESP_OK || up == ESP_ERR_INVALID_STATE);
}

TEST_CASE("the claim code is six digits and the same on every ask", "[provision]")
{
    storage_up();
    char first[8] = { 0 };
    char again[8] = { 0 };
    TEST_ASSERT_EQUAL(ESP_OK, net_provision_claim(first, sizeof(first)));
    TEST_ASSERT_EQUAL(6, strlen(first));
    for (size_t i = 0; i < 6; ++i) {
        TEST_ASSERT_TRUE(first[i] >= '0' && first[i] <= '9');
    }
    TEST_ASSERT_EQUAL(ESP_OK, net_provision_claim(again, sizeof(again)));
    TEST_ASSERT_EQUAL_STRING(first, again);
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_SIZE, net_provision_claim(again, 6));
}

// The live cases ask the api this build names, over the wifi already in NVS.
static void join(void)
{
    storage_up();
    TEST_ASSERT_EQUAL(ESP_OK, net_wifi_start());
    TEST_ASSERT_EQUAL(ESP_OK, net_wifi_wait_connected(JOIN_TIMEOUT_MS));
}

// Only the host part: the url's scheme and path mean nothing to getaddrinfo.
static int resolve(const char *url)
{
    char host[96] = { 0 };
    const char *start = strstr(url, "://");
    start = start != NULL ? start + 3 : url;
    const size_t len = strcspn(start, ":/");
    memcpy(host, start, len < sizeof(host) - 1 ? len : sizeof(host) - 1);
    const struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_STREAM };
    struct addrinfo *found = NULL;
    const int said = getaddrinfo(host, NULL, &hints, &found);
    printf("resolve %s: %d\n", host, said);
    freeaddrinfo(found);
    return said;
}

TEST_CASE("the link's dns resolves the api and the broker", "[provision][live]")
{
    join();
    resolve("pool.ntp.org");
    TEST_ASSERT_EQUAL(0, resolve(CONFIG_NET_PROVISION_API_URL));
    TEST_ASSERT_EQUAL(0, resolve("mqtt.cckiosk.io.vn"));
}

// A buffer shorter than the ticket reads as "absent", so the probe takes a whole one.
static bool holds_ticket(void)
{
    static char held[TICKET_CAP];
    return sys_storage_get_str(STORAGE_NS_DEVICE, STORAGE_KEY_TICKET, held, sizeof(held)) ==
               ESP_OK &&
           held[0] != '\0';
}

TEST_CASE("the api answers a registration with a verdict, not silence", "[provision][live]")
{
    if (holds_ticket()) {
        TEST_IGNORE_MESSAGE("registering again would send this approved board back to pending");
    }
    const net_provision_answer_t said = net_provision_register();
    TEST_ASSERT_NOT_EQUAL(NET_PROVISION_UNREACHABLE, said);
    TEST_ASSERT_NOT_EQUAL(NET_PROVISION_DISABLED, said);
}

TEST_CASE("a kiosk holding no ticket is told it has none", "[provision][live]")
{
    if (holds_ticket()) {
        TEST_IGNORE_MESSAGE("this board already holds a ticket");
    }
    TEST_ASSERT_EQUAL(NET_PROVISION_REFUSED, net_provision_check());
}

void app_main(void)
{
    // Without the driver the 64-byte console FIFO drops whatever Unity prints faster than it drains.
    usb_serial_jtag_driver_config_t console = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    if (usb_serial_jtag_driver_install(&console) == ESP_OK) {
        usb_serial_jtag_vfs_use_driver();
    }
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
