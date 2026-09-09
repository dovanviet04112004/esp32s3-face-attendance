#include "drv_lcd.h"

#include "app_config.h"
#include "app_err.h"
#include "bsp_board.h"
#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_st7796.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "drv_lcd";

#define BLK_TIMER LEDC_TIMER_0
#define BLK_CHANNEL LEDC_CHANNEL_0
#define BLK_DUTY_BITS LEDC_TIMER_10_BIT
#define BLK_DUTY_MAX ((1u << BLK_DUTY_BITS) - 1u)
#define PANEL_CMD_BITS 8
#define PANEL_PARAM_BITS 8
#define BOUNCE_ROWS 48
#define BOUNCE_PIXELS (APP_LCD_H_RES * BOUNCE_ROWS)
#define BOUNCE_BYTES (BOUNCE_PIXELS * (int)sizeof(uint16_t))
#define BOUNCE_COUNT 2
#define BOUNCE_WAIT_MS 200
#define CMDSET_REG 0xF0
#define CMDSET_UNLOCK_A 0xC3
#define CMDSET_UNLOCK_B 0x96
#define CMDSET_LOCK_A 0x3C
#define CMDSET_LOCK_B 0x69
#define FRAME_RATE_REG 0xB1
#define FRAME_RATE_DIVA 0x81
#define FRAME_RATE_RTNA 0x1F
#define VCOM_REG 0xC5
// The library's 0x18 leaves this module flickering at 23 Hz; 0x2C-0x34 measured calm (KEHOACH 2.3A).
#define VCOM_LEVEL 0x30
#define INVERSION_REG 0xB4
// White still flickers under 1-dot and 2-dot inversion at 23 Hz; column inversion measured calm.
#define INVERSION_COLUMN 0x00
#define SCANLINE_REG 0x45
#define SCANLINE_UNITS 242
#define SCANLINE_LEAD 220
#define SYNC_TICK_CEILING 60
#define CS_FRAME_GAP_US 1

static esp_lcd_panel_handle_t s_panel;
static esp_lcd_panel_io_handle_t s_io;
static uint16_t *s_bounce[BOUNCE_COUNT];
static SemaphoreHandle_t s_bounce_free;
static int s_next;
static uint16_t s_column_map[APP_LCD_H_RES];
static int s_map_width;
static spi_device_handle_t s_reader;

static esp_err_t backlight_up(void)
{
    const ledc_timer_config_t timer = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .timer_num = BLK_TIMER,
        .duty_resolution = BLK_DUTY_BITS,
        .freq_hz = APP_LCD_BLK_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    APP_RETURN_ON_ERR(ledc_timer_config(&timer), TAG, "blk timer");
    const ledc_channel_config_t channel = {
        .gpio_num = APP_LCD_BLK_GPIO,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = BLK_CHANNEL,
        .timer_sel = BLK_TIMER,
        .duty = 0,
        .hpoint = 0,
    };
    return ledc_channel_config(&channel);
}

static bool bounce_sent(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *event,
                        void *ctx)
{
    (void)io;
    (void)event;
    (void)ctx;
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(s_bounce_free, &woken);
    return woken == pdTRUE;
}

static esp_err_t chip_select_up(void)
{
    const gpio_config_t cs = {
        .pin_bit_mask = 1ULL << APP_LCD_CS_GPIO,
        .mode = GPIO_MODE_OUTPUT,
    };
    APP_RETURN_ON_ERR(gpio_config(&cs), TAG, "cs");
    return gpio_set_level(APP_LCD_CS_GPIO, 0);
}

static esp_err_t reader_up(void)
{
    // The bus leaves this pin's output driver on, and an esp driving it is an
    // esp the panel cannot pull low: every read comes back all ones.
    APP_RETURN_ON_ERR(gpio_set_direction(APP_LCD_SDO_GPIO, GPIO_MODE_INPUT), TAG, "sdo as input");
    const spi_device_interface_config_t cfg = {
        .clock_speed_hz = APP_LCD_READ_HZ,
        .mode = 0,
        .spics_io_num = GPIO_NUM_NC,
        .queue_size = 1,
        .flags = SPI_DEVICE_HALFDUPLEX,
    };
    return spi_bus_add_device(bsp_lcd_spi_host(), &cfg, &s_reader);
}

static void slow_the_scan(void)
{
    esp_lcd_panel_io_tx_param(s_io, CMDSET_REG, (uint8_t[]){CMDSET_UNLOCK_A}, 1);
    esp_lcd_panel_io_tx_param(s_io, CMDSET_REG, (uint8_t[]){CMDSET_UNLOCK_B}, 1);
    esp_lcd_panel_io_tx_param(s_io, FRAME_RATE_REG,
                              (uint8_t[]){FRAME_RATE_DIVA, FRAME_RATE_RTNA}, 2);
    esp_lcd_panel_io_tx_param(s_io, VCOM_REG, (uint8_t[]){VCOM_LEVEL}, 1);
    esp_lcd_panel_io_tx_param(s_io, INVERSION_REG, (uint8_t[]){INVERSION_COLUMN}, 1);
    esp_lcd_panel_io_tx_param(s_io, CMDSET_REG, (uint8_t[]){CMDSET_LOCK_A}, 1);
    esp_lcd_panel_io_tx_param(s_io, CMDSET_REG, (uint8_t[]){CMDSET_LOCK_B}, 1);
}

static int scan_line(void)
{
    uint8_t raw[2] = {0};
    // esp_lcd disables the dc output driver after each of its transactions, so
    // a level set here would float and the panel would take the command as data.
    gpio_set_direction(APP_LCD_DC_GPIO, GPIO_MODE_OUTPUT);
    gpio_set_level(APP_LCD_CS_GPIO, 1);
    esp_rom_delay_us(CS_FRAME_GAP_US);
    gpio_set_level(APP_LCD_CS_GPIO, 0);
    gpio_set_level(APP_LCD_DC_GPIO, 0);
    spi_transaction_t cmd = {
        .flags = SPI_TRANS_USE_TXDATA,
        .length = 8,
        .tx_data = {SCANLINE_REG},
    };
    esp_err_t err = spi_device_polling_transmit(s_reader, &cmd);
    if (err == ESP_OK) {
        gpio_set_level(APP_LCD_DC_GPIO, 1);
        spi_transaction_t rd = {
            .flags = SPI_TRANS_USE_RXDATA,
            .rxlength = 16,
        };
        err = spi_device_polling_transmit(s_reader, &rd);
        raw[0] = rd.rx_data[0];
        raw[1] = rd.rx_data[1];
    }
    gpio_set_level(APP_LCD_CS_GPIO, 1);
    esp_rom_delay_us(CS_FRAME_GAP_US);
    gpio_set_level(APP_LCD_CS_GPIO, 0);
    return err == ESP_OK ? (((raw[0] & 0x03) << 8) | raw[1]) : -1;
}

static void drain_bounce(void)
{
    for (int i = 0; i < BOUNCE_COUNT; ++i) {
        xSemaphoreTake(s_bounce_free, pdMS_TO_TICKS(BOUNCE_WAIT_MS));
    }
    for (int i = 0; i < BOUNCE_COUNT; ++i) {
        xSemaphoreGive(s_bounce_free);
    }
}

static void wait_for_scan_lead(void)
{
    drain_bounce();
    for (int tick = 0; tick < SYNC_TICK_CEILING; ++tick) {
        const int line = scan_line();
        // A reading past the counter's range means the sync line is not
        // answering, and an unsynced frame beats a stalled preview.
        if (line < 0 || line > SCANLINE_UNITS || line >= SCANLINE_LEAD) {
            return;
        }
        vTaskDelay(1);
    }
}

static esp_err_t panel_up(void)
{
    const esp_lcd_panel_io_spi_config_t io_cfg = {
        .cs_gpio_num = GPIO_NUM_NC,
        .dc_gpio_num = APP_LCD_DC_GPIO,
        .spi_mode = 0,
        .pclk_hz = APP_LCD_SPI_HZ,
        .trans_queue_depth = BOUNCE_COUNT,
        // The transfer is queued, not done, when draw_bitmap returns, so a
        // buffer is only free to refill once this callback hands it back.
        .on_color_trans_done = bounce_sent,
        .lcd_cmd_bits = PANEL_CMD_BITS,
        .lcd_param_bits = PANEL_PARAM_BITS,
    };
    APP_RETURN_ON_ERR(
        esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)bsp_lcd_spi_host(), &io_cfg, &s_io),
        TAG, "panel io");

    const esp_lcd_panel_dev_config_t dev_cfg = {
        .reset_gpio_num = APP_LCD_RST_GPIO,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR,
        .bits_per_pixel = 16,
    };
    APP_RETURN_ON_ERR(esp_lcd_new_panel_st7796(s_io, &dev_cfg, &s_panel), TAG, "panel");

    APP_RETURN_ON_ERR(esp_lcd_panel_reset(s_panel), TAG, "reset");
    APP_RETURN_ON_ERR(esp_lcd_panel_init(s_panel), TAG, "init");
    // This module answers INVON with a negative and carries its column driver
    // reversed; the corner marks in test_apps/panel read both off the glass.
    APP_RETURN_ON_ERR(esp_lcd_panel_invert_color(s_panel, false), TAG, "invert");
    APP_RETURN_ON_ERR(esp_lcd_panel_swap_xy(s_panel, false), TAG, "swap xy");
    APP_RETURN_ON_ERR(esp_lcd_panel_mirror(s_panel, true, false), TAG, "mirror");
    // One frame takes longer to write than the scan takes to cross it, and the
    // writer only stays ahead if the scan is the slower of the two (KEHOACH 2.3A).
    slow_the_scan();
    return esp_lcd_panel_disp_on_off(s_panel, true);
}

esp_err_t drv_lcd_init(void)
{
    if (s_panel != NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    // SPI DMA reaches internal RAM only, so every pixel bound for the panel
    // crosses one of these, claimed once at boot and never freed.
    s_bounce_free = xSemaphoreCreateCounting(BOUNCE_COUNT, BOUNCE_COUNT);
    if (s_bounce_free == NULL) {
        return ESP_ERR_NO_MEM;
    }
    for (int i = 0; i < BOUNCE_COUNT; ++i) {
        s_bounce[i] = heap_caps_malloc(BOUNCE_BYTES, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
        if (s_bounce[i] == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }
    APP_RETURN_ON_ERR(chip_select_up(), TAG, "chip select");
    APP_RETURN_ON_ERR(backlight_up(), TAG, "backlight");
    APP_RETURN_ON_ERR(panel_up(), TAG, "panel");
    APP_RETURN_ON_ERR(reader_up(), TAG, "scanline reader");
    ESP_LOGI(TAG, "st7796 up at %dx%d, %d bounce of %d B, scanline reads %d", APP_LCD_H_RES,
             APP_LCD_V_RES, BOUNCE_COUNT, BOUNCE_BYTES, scan_line());
    return ESP_OK;
}

esp_err_t drv_lcd_backlight(uint8_t percent)
{
    const uint32_t duty = (percent > 100 ? 100u : percent) * BLK_DUTY_MAX / 100u;
    APP_RETURN_ON_ERR(ledc_set_duty(LEDC_LOW_SPEED_MODE, BLK_CHANNEL, duty), TAG, "duty");
    return ledc_update_duty(LEDC_LOW_SPEED_MODE, BLK_CHANNEL);
}

static esp_err_t claim_bounce(uint16_t **out)
{
    if (xSemaphoreTake(s_bounce_free, pdMS_TO_TICKS(BOUNCE_WAIT_MS)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    *out = s_bounce[s_next];
    s_next = (s_next + 1) % BOUNCE_COUNT;
    return ESP_OK;
}

static esp_err_t send_bounce(int x1, int y1, int x2, int y2, uint16_t *filled)
{
    const esp_err_t err = esp_lcd_panel_draw_bitmap(s_panel, x1, y1, x2, y2, filled);
    if (err != ESP_OK) {
        xSemaphoreGive(s_bounce_free);
    }
    return err;
}

esp_err_t drv_lcd_blit(int x1, int y1, int x2, int y2, const void *pixels)
{
    const int width = x2 - x1;
    if (width <= 0 || y2 <= y1 || width > BOUNCE_PIXELS) {
        return ESP_ERR_INVALID_SIZE;
    }
    const int rows_per_strip = BOUNCE_PIXELS / width;
    const uint16_t *src = pixels;
    for (int y = y1; y < y2; y += rows_per_strip) {
        const int rows = (y + rows_per_strip <= y2) ? rows_per_strip : y2 - y;
        uint16_t *dst = NULL;
        APP_RETURN_ON_ERR(claim_bounce(&dst), TAG, "bounce");
        // The panel reads RGB565 high byte first, and an ESP word holds it low
        // byte first, so every pixel turns over on its way to the wire.
        for (int i = 0; i < rows * width; ++i) {
            dst[i] = __builtin_bswap16(src[i]);
        }
        APP_RETURN_ON_ERR(send_bounce(x1, y, x2, y + rows, dst), TAG, "strip");
        src += rows * width;
    }
    return ESP_OK;
}

static void build_column_map(int src_width, int taken_width)
{
    if (s_map_width == src_width) {
        return;
    }
    const int left = (src_width - taken_width) / 2;
    for (int x = 0; x < APP_LCD_H_RES; ++x) {
        s_column_map[x] = (uint16_t)(left + (x * taken_width) / APP_LCD_H_RES);
    }
    s_map_width = src_width;
}

esp_err_t drv_lcd_blit_frame(const void *pixels, int src_width, int src_height)
{
    if (src_width <= 0 || src_height <= 0) {
        return ESP_ERR_INVALID_SIZE;
    }
    // The sensor is soldered across the board and only ever sees a lying frame,
    // so a standing view is the tallest centre slice that shares the panel's shape.
    const int taken_width = (src_height * APP_LCD_H_RES) / APP_LCD_V_RES;
    if (taken_width <= 0 || taken_width > src_width) {
        return ESP_ERR_INVALID_SIZE;
    }
    build_column_map(src_width, taken_width);
    wait_for_scan_lead();
    const int rows_per_strip = BOUNCE_PIXELS / APP_LCD_H_RES;
    const uint16_t *src = pixels;

    for (int y = 0; y < APP_LCD_V_RES; y += rows_per_strip) {
        const int rows =
            (y + rows_per_strip <= APP_LCD_V_RES) ? rows_per_strip : APP_LCD_V_RES - y;
        uint16_t *dst = NULL;
        APP_RETURN_ON_ERR(claim_bounce(&dst), TAG, "bounce");
        for (int r = 0; r < rows; ++r) {
            const uint16_t *row =
                src + (size_t)(((y + r) * src_height) / APP_LCD_V_RES) * src_width;
            uint16_t *out = dst + r * APP_LCD_H_RES;
            for (int x = 0; x < APP_LCD_H_RES; ++x) {
                out[x] = row[s_column_map[x]];
            }
        }
        APP_RETURN_ON_ERR(send_bounce(0, y, APP_LCD_H_RES, y + rows, dst), TAG, "strip");
    }
    return ESP_OK;
}

esp_err_t drv_lcd_fill(uint16_t rgb565)
{
    const int rows_per_strip = BOUNCE_PIXELS / APP_LCD_H_RES;
    const uint16_t wire = __builtin_bswap16(rgb565);
    for (int y = 0; y < APP_LCD_V_RES; y += rows_per_strip) {
        const int rows = (y + rows_per_strip <= APP_LCD_V_RES) ? rows_per_strip : APP_LCD_V_RES - y;
        uint16_t *dst = NULL;
        APP_RETURN_ON_ERR(claim_bounce(&dst), TAG, "bounce");
        for (int i = 0; i < rows * APP_LCD_H_RES; ++i) {
            dst[i] = wire;
        }
        APP_RETURN_ON_ERR(send_bounce(0, y, APP_LCD_H_RES, y + rows, dst), TAG, "strip");
    }
    return ESP_OK;
}

esp_lcd_panel_handle_t drv_lcd_panel(void)
{
    return s_panel;
}
