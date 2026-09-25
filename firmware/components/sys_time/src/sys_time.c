#include "sys_time.h"

#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/time.h>
#include <time.h>

#include "app_err.h"
#include "bsp_board.h"
#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "esp_timer.h"

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
#define RTC_LAST_YEAR (RTC_YEAR_BASE + 99) // two BCD digits of year
#define SERVER_CAP 64
#define MS_PER_S 1000
#define US_PER_MS 1000
#define DAYS_TO_EPOCH 719468               // 0000-03-01 to 1970-01-01, civil
#define EPOCH_WEEKDAY 4                    // Thursday, 1970-01-01

static i2c_master_dev_handle_t s_rtc;
static _Atomic sys_time_source_t s_source;
static _Atomic bool s_ntp_marker;
static bool s_ready;
static bool s_sync_started;
static char s_server[SERVER_CAP];
static sys_time_synced_cb s_on_synced;
static void *s_on_synced_arg;

static const char kDayNames[7][4] = { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" };
static const char kMonthNames[12][4] = { "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                         "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };

static const char *source_name(sys_time_source_t source)
{
    switch (source) {
    case SYS_TIME_SOURCE_RTC: return "rtc";
    case SYS_TIME_SOURCE_RTC_NTP: return "rtc_ntp";
    case SYS_TIME_SOURCE_API: return "api";
    default: return "none";
    }
}

static uint8_t to_bcd(unsigned value)
{
    return (uint8_t)(((value / 10u) << 4) | (value % 10u));
}

static unsigned from_bcd(uint8_t value)
{
    return (value >> 4) * 10u + (value & 0x0Fu);
}

static int64_t wall_ms(void)
{
    struct timeval now = { 0 };
    gettimeofday(&now, NULL);
    return (int64_t)now.tv_sec * MS_PER_S + now.tv_usec / US_PER_MS;
}

static int64_t boot_ms(void)
{
    return esp_timer_get_time() / US_PER_MS;
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

// Days from 1970-01-01 to a proleptic Gregorian date (Hinnant, days_from_civil).
static int64_t days_from_civil(int year, int month, int day)
{
    year -= month <= 2;
    const int era = (year >= 0 ? year : year - 399) / 400;
    const int yoe = year - era * 400;
    const int doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
    const int doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return (int64_t)era * 146097 + doe - DAYS_TO_EPOCH;
}

static int days_in_month(int year, int month)
{
    static const uint8_t kLength[12] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    const bool leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    return month == 2 && leap ? 29 : kLength[month - 1];
}

// A calendar date the RTC can hold, or -1: its two BCD digits start at 2000.
static int64_t civil_ms(int year, int month, int day, int hour, int minute, int second)
{
    if (year < RTC_YEAR_BASE || year > RTC_LAST_YEAR || month < 1 || month > 12 || day < 1 ||
        day > days_in_month(year, month) || hour > 23 || minute > 59 || second > 60) {
        return -1;
    }
    const int64_t days = days_from_civil(year, month, day);
    return ((days * 24 + hour) * 60 + minute) * 60 * MS_PER_S + (int64_t)second * MS_PER_S;
}

// The chip counts in local time with no zone of its own, so the whole system
// stays on UTC and the display layer is the only place a zone appears.
static esp_err_t rtc_to_system(void)
{
    uint8_t regs[TIME_BYTES] = { 0 };
    APP_RETURN_ON_ERR(read_regs(TIME_REG, regs, sizeof(regs)), TAG, "time");
    const int64_t at_ms =
        civil_ms((int)from_bcd(regs[6]) + RTC_YEAR_BASE, (int)from_bcd(regs[5] & 0x1F),
                 (int)from_bcd(regs[4] & 0x3F), (int)from_bcd(regs[2] & 0x3F),
                 (int)from_bcd(regs[1]), (int)from_bcd(regs[0] & 0x7F));
    if (at_ms < SYS_TIME_FLOOR_MS) {
        return ESP_ERR_INVALID_RESPONSE;
    }
    const struct timeval now = { .tv_sec = (time_t)(at_ms / MS_PER_S), .tv_usec = 0 };
    return settimeofday(&now, NULL) == 0 ? ESP_OK : ESP_FAIL;
}

static void tell_synced(void)
{
    if (s_on_synced != NULL) {
        s_on_synced(atomic_load(&s_ntp_marker), s_on_synced_arg);
    }
}

// Lands on the lwip task with the clock already set, so the source rises even
// when the RTC refuses the write, and the next sync tries the write again.
static void on_sntp(struct timeval *tv)
{
    (void)tv;
    atomic_store(&s_source, SYS_TIME_SOURCE_RTC_NTP);
    const esp_err_t kept = sys_time_write_rtc();
    if (kept == ESP_OK) {
        atomic_store(&s_ntp_marker, true);
        ESP_LOGI(TAG, "sntp synced, rtc rewritten");
    } else {
        ESP_LOGW(TAG, "sntp synced, rtc not rewritten: %s", esp_err_to_name(kept));
    }
    tell_synced();
}

esp_err_t sys_time_init(bool rtc_ntp_set, sys_time_synced_cb on_synced, void *arg)
{
    if (s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    s_ready = true;
    s_on_synced = on_synced;
    s_on_synced_arg = arg;
    atomic_store(&s_ntp_marker, rtc_ntp_set);
    APP_RETURN_ON_ERR(attach(), TAG, "attach");

    uint8_t status = 0;
    if (read_regs(STATUS_REG, &status, 1) != ESP_OK) {
        ESP_LOGW(TAG, "rtc silent: no clock until sntp or the api");
        return ESP_ERR_NOT_FOUND;
    }
    if ((status & OSF_BIT) != 0) {
        ESP_LOGW(TAG, "rtc oscillator flag set: no clock until sntp or the api");
        return ESP_OK;
    }
    APP_RETURN_ON_ERR(rtc_to_system(), TAG, "rtc holds no date after 2020");
    atomic_store(&s_source, rtc_ntp_set ? SYS_TIME_SOURCE_RTC_NTP : SYS_TIME_SOURCE_RTC);
    ESP_LOGI(TAG, "clock from rtc, source %s", source_name(atomic_load(&s_source)));
    return ESP_OK;
}

sys_time_source_t sys_time_source(void)
{
    return atomic_load(&s_source);
}

bool sys_time_trusted(void)
{
    const sys_time_source_t source = atomic_load(&s_source);
    return source == SYS_TIME_SOURCE_RTC_NTP || source == SYS_TIME_SOURCE_API;
}

int64_t sys_time_now_ms(void)
{
    return atomic_load(&s_source) == SYS_TIME_SOURCE_NONE ? boot_ms() : wall_ms();
}

esp_err_t sys_time_boot_at_ms(int64_t *out)
{
    if (out == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!sys_time_trusted()) {
        return ESP_ERR_INVALID_STATE;
    }
    *out = wall_ms() - boot_ms();
    return ESP_OK;
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

esp_err_t sys_time_sync_start(const char *server)
{
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    if (server == NULL || server[0] == '\0' || strlen(server) >= sizeof(s_server)) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_sync_started) {
        APP_RETURN_ON_ERR(esp_netif_sntp_start(), TAG, "sntp restart");
        ESP_LOGI(TAG, "sntp asked again against %s", s_server);
        return ESP_OK;
    }
    // lwip keeps the pointer rather than the name (esp_netif_sntp.c, sntp_init_api).
    strlcpy(s_server, server, sizeof(s_server));
    esp_sntp_config_t cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG(s_server);
    cfg.sync_cb = on_sntp;
    cfg.start = true;
    APP_RETURN_ON_ERR(esp_netif_sntp_init(&cfg), TAG, "sntp");
    s_sync_started = true;
    ESP_LOGI(TAG, "sntp started against %s", s_server);
    return ESP_OK;
}

static int name_at(const char *at, const char (*names)[4], int count)
{
    for (int i = 0; i < count; ++i) {
        if (strncasecmp(at, names[i], 3) == 0) {
            return i;
        }
    }
    return -1;
}

static bool take_digits(const char **at, int digits, int *out)
{
    int value = 0;
    for (int i = 0; i < digits; ++i) {
        const char c = (*at)[i];
        if (c < '0' || c > '9') {
            return false;
        }
        value = value * 10 + (c - '0');
    }
    *at += digits;
    *out = value;
    return true;
}

static bool take_char(const char **at, char want)
{
    if (**at != want) {
        return false;
    }
    ++*at;
    return true;
}

static bool take_spaces(const char **at)
{
    const char *from = *at;
    while (**at == ' ' || **at == '\t') {
        ++*at;
    }
    return *at != from;
}

esp_err_t sys_time_parse_http_date(const char *value, int64_t *epoch_ms)
{
    if (value == NULL || epoch_ms == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    const char *at = value;
    take_spaces(&at);
    const int weekday = name_at(at, kDayNames, 7);
    if (weekday < 0) {
        return ESP_ERR_INVALID_ARG;
    }
    at += 3;
    int day = 0, year = 0, hour = 0, minute = 0, second = 0;
    if (!take_char(&at, ',') || !take_spaces(&at) || !take_digits(&at, 2, &day) ||
        !take_spaces(&at)) {
        return ESP_ERR_INVALID_ARG;
    }
    const int month = name_at(at, kMonthNames, 12) + 1;
    if (month == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    at += 3;
    if (!take_spaces(&at) || !take_digits(&at, 4, &year) || !take_spaces(&at) ||
        !take_digits(&at, 2, &hour) || !take_char(&at, ':') || !take_digits(&at, 2, &minute) ||
        !take_char(&at, ':') || !take_digits(&at, 2, &second) || !take_spaces(&at) ||
        strncasecmp(at, "GMT", 3) != 0) {
        return ESP_ERR_INVALID_ARG;
    }
    at += 3;
    take_spaces(&at);
    const int64_t ms = civil_ms(year, month, day, hour, minute, second);
    // A weekday that disagrees with the date is a header nobody should set a clock by.
    if (*at != '\0' || ms < SYS_TIME_FLOOR_MS ||
        (days_from_civil(year, month, day) + EPOCH_WEEKDAY) % 7 != weekday) {
        return ESP_ERR_INVALID_ARG;
    }
    *epoch_ms = ms;
    return ESP_OK;
}

esp_err_t sys_time_take_http_date(const char *value, int64_t heard_at_us)
{
    int64_t date_ms = 0;
    if (sys_time_parse_http_date(value, &date_ms) != ESP_OK) {
        return ESP_ERR_INVALID_ARG;
    }
    sys_time_source_t held = atomic_load(&s_source);
    if (!s_ready || held == SYS_TIME_SOURCE_RTC_NTP) {
        return ESP_ERR_INVALID_STATE;
    }
    const int64_t now_ms = date_ms + (esp_timer_get_time() - heard_at_us) / US_PER_MS;
    const int64_t step_ms = now_ms - wall_ms();
    // A Date is whole seconds, so a smaller step is its own rounding, not news.
    if (held == SYS_TIME_SOURCE_API && llabs(step_ms) < MS_PER_S) {
        return ESP_OK;
    }
    const struct timeval tv = { .tv_sec = (time_t)(now_ms / MS_PER_S),
                                .tv_usec = (suseconds_t)(now_ms % MS_PER_S) * US_PER_MS };
    if (settimeofday(&tv, NULL) != 0) {
        return ESP_FAIL;
    }
    // NTP landing after the load keeps the source, and its next sync mends this step.
    if (!atomic_compare_exchange_strong(&s_source, &held, SYS_TIME_SOURCE_API)) {
        return ESP_ERR_INVALID_STATE;
    }
    const esp_err_t kept = sys_time_write_rtc();
    if (kept == ESP_OK) {
        atomic_store(&s_ntp_marker, false);
    }
    ESP_LOGI(TAG, "clock from the api's date, stepped %+lld ms from %s, rtc %s",
             (long long)step_ms, source_name(held), esp_err_to_name(kept));
    tell_synced();
    return ESP_OK;
}
