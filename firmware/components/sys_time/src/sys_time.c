#include "sys_time.h"

#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "app_err.h"
#include "bsp_board.h"
#include <stdlib.h>

#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "esp_sntp.h"

static const char *TAG = "sys_time";

#define RTC_ADDR 0x68
#define RTC_SPEED_HZ 100000
#define TIME_REG 0x00
#define STATUS_REG 0x0F
#define OSF_BIT 0x80
#define TIME_BYTES 7
#define LOCK_TIMEOUT_MS 200
#define IO_TIMEOUT_MS 100
#define EPOCH_YEAR 1900
#define RTC_YEAR_BASE 2000

static i2c_master_dev_handle_t s_rtc;
static sys_time_source_t s_source;
static bool s_ntp_marker;
static bool s_sync_started;
static sys_time_synced_cb s_on_synced;
static void *s_on_synced_arg;

static uint8_t to_bcd(unsigned value)
{
    return (uint8_t)(((value / 10u) << 4) | (value % 10u));
}

static unsigned from_bcd(uint8_t value)
{
    return (value >> 4) * 10u + (value & 0x0Fu);
}

static esp_err_t read_regs(uint8_t reg, uint8_t *out, size_t len)
{
    APP_RETURN_ON_ERR(bsp_i2c_lock(LOCK_TIMEOUT_MS), TAG, "lock");
    const esp_err_t err = i2c_master_transmit_receive(s_rtc, &reg, 1, out, len, IO_TIMEOUT_MS);
    bsp_i2c_unlock();
    return err;
}

static esp_err_t write_regs(uint8_t reg, const uint8_t *data, size_t len)
{
    uint8_t frame[1 + TIME_BYTES];
    if (len > TIME_BYTES) {
        return ESP_ERR_INVALID_SIZE;
    }
    frame[0] = reg;
    memcpy(&frame[1], data, len);
    APP_RETURN_ON_ERR(bsp_i2c_lock(LOCK_TIMEOUT_MS), TAG, "lock");
    const esp_err_t err = i2c_master_transmit(s_rtc, frame, len + 1, IO_TIMEOUT_MS);
    bsp_i2c_unlock();
    return err;
}

static esp_err_t attach(void)
{
    const i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = RTC_ADDR,
        .scl_speed_hz = RTC_SPEED_HZ,
    };
    return i2c_master_bus_add_device(bsp_i2c_bus(), &cfg, &s_rtc);
}

// The chip counts in local time with no zone of its own, so the whole system
// stays on UTC and the display layer is the only place a zone appears.
static esp_err_t rtc_to_system(void)
{
    uint8_t regs[TIME_BYTES] = { 0 };
    APP_RETURN_ON_ERR(read_regs(TIME_REG, regs, sizeof(regs)), TAG, "time");
    struct tm parts = {
        .tm_sec = (int)from_bcd(regs[0] & 0x7F),
        .tm_min = (int)from_bcd(regs[1]),
        .tm_hour = (int)from_bcd(regs[2] & 0x3F),
        .tm_mday = (int)from_bcd(regs[4] & 0x3F),
        .tm_mon = (int)from_bcd(regs[5] & 0x1F) - 1,
        .tm_year = (int)from_bcd(regs[6]) + RTC_YEAR_BASE - EPOCH_YEAR,
    };
    const time_t seconds = timegm(&parts);
    if (seconds < 0) {
        return ESP_ERR_INVALID_RESPONSE;
    }
    const struct timeval now = { .tv_sec = seconds, .tv_usec = 0 };
    return settimeofday(&now, NULL) == 0 ? ESP_OK : ESP_FAIL;
}

static void on_sntp(struct timeval *tv)
{
    (void)tv;
    if (sys_time_write_rtc() != ESP_OK) {
        ESP_LOGW(TAG, "sntp landed but the rtc refused the write");
        return;
    }
    s_ntp_marker = true;
    s_source = SYS_TIME_SOURCE_RTC_NTP;
    ESP_LOGI(TAG, "sntp synced, rtc rewritten");
    if (s_on_synced != NULL) {
        s_on_synced(s_on_synced_arg);
    }
}

esp_err_t sys_time_init(bool rtc_ntp_set)
{
    if (s_rtc != NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    APP_RETURN_ON_ERR(attach(), TAG, "attach");
    s_ntp_marker = rtc_ntp_set;

    uint8_t status = 0;
    if (read_regs(STATUS_REG, &status, 1) != ESP_OK) {
        i2c_master_bus_rm_device(s_rtc);
        s_rtc = NULL;
        return ESP_ERR_NOT_FOUND;
    }
    if ((status & OSF_BIT) != 0) {
        s_source = SYS_TIME_SOURCE_NONE;
        ESP_LOGW(TAG, "rtc oscillator flag set: no clock until sntp");
        return ESP_OK;
    }
    APP_RETURN_ON_ERR(rtc_to_system(), TAG, "load");
    s_source = s_ntp_marker ? SYS_TIME_SOURCE_RTC_NTP : SYS_TIME_SOURCE_RTC;
    ESP_LOGI(TAG, "clock from rtc, source %d", (int)s_source);
    return ESP_OK;
}

sys_time_source_t sys_time_source(void)
{
    return s_source;
}

int64_t sys_time_now_ms(void)
{
    if (s_source == SYS_TIME_SOURCE_NONE) {
        return 0;
    }
    struct timeval now = { 0 };
    gettimeofday(&now, NULL);
    return (int64_t)now.tv_sec * 1000 + now.tv_usec / 1000;
}

esp_err_t sys_time_write_rtc(void)
{
    if (s_rtc == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    struct timeval now = { 0 };
    gettimeofday(&now, NULL);
    struct tm parts;
    gmtime_r(&now.tv_sec, &parts);
    const uint8_t regs[TIME_BYTES] = {
        to_bcd((unsigned)parts.tm_sec),
        to_bcd((unsigned)parts.tm_min),
        to_bcd((unsigned)parts.tm_hour),
        to_bcd((unsigned)parts.tm_wday + 1u),
        to_bcd((unsigned)parts.tm_mday),
        to_bcd((unsigned)parts.tm_mon + 1u),
        to_bcd((unsigned)(parts.tm_year + EPOCH_YEAR - RTC_YEAR_BASE)),
    };
    APP_RETURN_ON_ERR(write_regs(TIME_REG, regs, sizeof(regs)), TAG, "set");

    uint8_t status = 0;
    APP_RETURN_ON_ERR(read_regs(STATUS_REG, &status, 1), TAG, "status");
    // The flag latches from the moment the oscillator stopped and only firmware
    // clears it, so a fresh time is worthless until this write happens.
    status &= (uint8_t)~OSF_BIT;
    return write_regs(STATUS_REG, &status, 1);
}

esp_err_t sys_time_set_zone(const char *posix_tz)
{
    if (posix_tz == NULL || posix_tz[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    setenv("TZ", posix_tz, 1);
    tzset();
    ESP_LOGI(TAG, "zone %s", posix_tz);
    return ESP_OK;
}

esp_err_t sys_time_sync_start(const char *server, sys_time_synced_cb on_synced, void *arg)
{
    if (s_rtc == NULL || s_sync_started || server == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    s_on_synced = on_synced;
    s_on_synced_arg = arg;
    esp_sntp_config_t cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG(server);
    cfg.sync_cb = on_sntp;
    cfg.start = true;
    APP_RETURN_ON_ERR(esp_netif_sntp_init(&cfg), TAG, "sntp");
    s_sync_started = true;
    ESP_LOGI(TAG, "sntp started against %s", server);
    return ESP_OK;
}
