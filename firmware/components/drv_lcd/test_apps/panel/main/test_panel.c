#include "app_config.h"
#include "bsp_board.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "drv_lcd.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include <inttypes.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "unity.h"

#define SENSOR_PIXELS (APP_LCD_H_RES * APP_LCD_V_RES)
#define MARK_SIDE 80
#define MARK_PIXELS (MARK_SIDE * MARK_SIDE)
#define MARK_HOLD_MS 6000

static const char *TAG = "test_panel";

#define RGB565(r, g, b) (uint16_t)(((r) & 0xF8) << 8 | ((g) & 0xFC) << 3 | (b) >> 3)
#define WHITE 0xFFFF
#define OVER_FULL 250
#define COLOUR_HOLD_MS 700
#define SWEEP_HOLD_MS 4000
#define POWER_MODE_REG 0x0A
#define SELF_TEST_REG 0x0F
#define SCANLINE_REG 0x45
#define CHIP_ID_REG 0xD3
#define PROBE_MS 6000
#define PROBE_BURST 200
#define PROBE_SLOTS 5
#define WRAP_FRAMES 200
#define WRAP_EARLY 40
#define WRAP_LATE 200
#define WRAP_CEILING_MS 20000
#define SWEEP_READS 2000
#define ST7796S_ID 0x007796
#define LAMP_ROUNDS 3
#define LAMP_AWAKE_MS 10000
#define LAMP_ASLEEP_MS 15000

static int64_t s_wrap_at[WRAP_FRAMES + 1];
static spi_device_handle_t s_reader;

static esp_err_t add_reader(int clock_hz, int input_delay_ns, spi_device_handle_t *out)
{
    const spi_device_interface_config_t cfg = {
        .clock_speed_hz = clock_hz,
        .mode = 0,
        .spics_io_num = GPIO_NUM_NC,
        .queue_size = 1,
        .input_delay_ns = input_delay_ns,
        .flags = SPI_DEVICE_HALFDUPLEX,
    };
    return spi_bus_add_device(bsp_lcd_spi_host(), &cfg, out);
}

// The hand-judged cases run first, so they cannot lean on the case below.
static void panel_up(void)
{
    const esp_err_t board = bsp_board_init();
    TEST_ASSERT_TRUE(board == ESP_OK || board == ESP_ERR_INVALID_STATE);
    const esp_err_t lcd = drv_lcd_init();
    TEST_ASSERT_TRUE(lcd == ESP_OK || lcd == ESP_ERR_INVALID_STATE);
    if (s_reader == NULL) {
        TEST_ASSERT_EQUAL(ESP_OK, add_reader(APP_LCD_READ_HZ, 0, &s_reader));
    }
}

static esp_err_t fill(uint16_t rgb565)
{
    const uint16_t panel_order = __builtin_bswap16(rgb565);
    // drv_lcd_paint leaves alone a strip no box reaches, so this box spans every row.
    const drv_lcd_overlay_t whole = {
        .boxes = 1,
        .box[0] = {.x1 = 0, .y1 = 0, .x2 = APP_LCD_H_RES, .y2 = APP_LCD_V_RES,
                   .rgb565 = panel_order, .edge_px = 1},
    };
    return drv_lcd_paint(&whole, panel_order);
}

static esp_err_t read_panel(spi_device_handle_t reader, uint8_t reg, uint8_t *raw, size_t bytes)
{
    gpio_set_direction(APP_LCD_DC_GPIO, GPIO_MODE_OUTPUT);
    gpio_set_level(APP_LCD_CS_GPIO, 1);
    esp_rom_delay_us(1);
    gpio_set_level(APP_LCD_CS_GPIO, 0);
    gpio_set_level(APP_LCD_DC_GPIO, 0);
    spi_transaction_t cmd = {
        .flags = SPI_TRANS_USE_TXDATA,
        .length = 8,
        .tx_data = {reg},
    };
    esp_err_t err = spi_device_polling_transmit(reader, &cmd);
    if (err == ESP_OK) {
        gpio_set_level(APP_LCD_DC_GPIO, 1);
        spi_transaction_t rd = {
            .flags = SPI_TRANS_USE_RXDATA,
            .rxlength = bytes * 8,
        };
        err = spi_device_polling_transmit(reader, &rd);
        if (err == ESP_OK) {
            memcpy(raw, rd.rx_data, bytes);
        }
    }
    gpio_set_level(APP_LCD_CS_GPIO, 1);
    esp_rom_delay_us(1);
    gpio_set_level(APP_LCD_CS_GPIO, 0);
    return err;
}

static uint32_t read_stream(spi_device_handle_t reader, uint8_t reg)
{
    uint8_t raw[4] = {0};
    read_panel(reader, reg, raw, sizeof(raw));
    return ((uint32_t)raw[0] << 24) | ((uint32_t)raw[1] << 16) | ((uint32_t)raw[2] << 8) | raw[3];
}

static uint32_t read_reg(uint8_t reg)
{
    // The 4-line read clocks one dummy bit out ahead of the data (DS V1.0 9.3.17).
    return (read_stream(s_reader, reg) << 1) >> 8;
}

static int scan_line(void)
{
    uint8_t raw[2] = {0};
    if (read_panel(s_reader, SCANLINE_REG, raw, sizeof(raw)) != ESP_OK) {
        return -1;
    }
    return ((raw[0] & 0x03) << 8) | raw[1];
}

// Declared ahead of the other hand-judged cases so it reaches the glass first.
TEST_CASE("the lamp on its own, panel asleep and no pwm anywhere", "[drv_lcd][manual]")
{
    const gpio_config_t flat = {
        .pin_bit_mask = 1ULL << APP_LCD_BLK_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
    };
    panel_up();
    TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_backlight(100));
    // Taking the pad back from ledc leaves the lamp lit with no pwm on it.
    TEST_ASSERT_EQUAL(ESP_OK, gpio_config(&flat));
    TEST_ASSERT_EQUAL(ESP_OK, gpio_set_level(APP_LCD_BLK_GPIO, 1));
    for (int round = 0; round < LAMP_ROUNDS; ++round) {
        TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_sleep(false));
        // Black while awake and untwisted glass while asleep, so the two phases
        // cannot be mistaken for each other on a normally white panel.
        TEST_ASSERT_EQUAL(ESP_OK, fill(0));
        printf("  round %d: DARK, panel awake driving black, %d ms, power mode %06" PRIx32 "\n",
               round + 1, LAMP_AWAKE_MS, read_reg(POWER_MODE_REG));
        vTaskDelay(pdMS_TO_TICKS(LAMP_AWAKE_MS));
        TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_sleep(true));
        printf("  round %d: BRIGHT, panel asleep, lamp alone, %d ms, power mode %06" PRIx32 "\n",
               round + 1, LAMP_ASLEEP_MS, read_reg(POWER_MODE_REG));
        vTaskDelay(pdMS_TO_TICKS(LAMP_ASLEEP_MS));
    }
    TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_sleep(false));
    TEST_ASSERT_EQUAL(ESP_OK, fill(0));
}

TEST_CASE("init brings the panel up and refuses a second time", "[drv_lcd]")
{
    panel_up();
    TEST_ASSERT_NOT_NULL(drv_lcd_panel());
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_STATE, drv_lcd_init());
}

TEST_CASE("backlight takes both ends and a value past full", "[drv_lcd]")
{
    TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_backlight(0));
    TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_backlight(100));
    TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_backlight(OVER_FULL));
}

TEST_CASE("fill covers the panel without leaking its scratch line", "[drv_lcd]")
{
    const size_t before = heap_caps_get_free_size(MALLOC_CAP_DMA);
    for (int i = 0; i < 16; ++i) {
        TEST_ASSERT_EQUAL(ESP_OK, fill(WHITE));
    }
    const size_t after = heap_caps_get_free_size(MALLOC_CAP_DMA);
    TEST_ASSERT_EQUAL(before, after);
}

TEST_CASE("the panel stands portrait, taller than it is wide", "[drv_lcd]")
{
    TEST_ASSERT_EQUAL(320, APP_LCD_H_RES);
    TEST_ASSERT_EQUAL(480, APP_LCD_V_RES);
}

TEST_CASE("a landscape sensor frame lands centred on the portrait panel", "[drv_lcd]")
{
    uint16_t *frame = heap_caps_malloc(SENSOR_PIXELS * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    TEST_ASSERT_NOT_NULL(frame);
    for (int i = 0; i < SENSOR_PIXELS; ++i) {
        frame[i] = (uint16_t)i;
    }
    TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_blit_frame(frame, APP_CAM_H_RES, APP_CAM_V_RES, NULL));
    heap_caps_free(frame);
}

TEST_CASE("a frame too tall to shrink into the panel is refused", "[drv_lcd]")
{
    uint16_t pixel = 0;
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_SIZE, drv_lcd_blit_frame(&pixel, 0, APP_CAM_V_RES, NULL));
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_SIZE, drv_lcd_blit_frame(&pixel, 10, 10000, NULL));
}

TEST_CASE("red, green, blue and white each reach the glass", "[drv_lcd][manual]")
{
    static const uint16_t colours[] = {RGB565(0xFF, 0, 0), RGB565(0, 0xFF, 0),
                                       RGB565(0, 0, 0xFF), WHITE};
    panel_up();
    TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_backlight(100));
    for (size_t i = 0; i < sizeof(colours) / sizeof(colours[0]); ++i) {
        TEST_ASSERT_EQUAL(ESP_OK, fill(colours[i]));
        vTaskDelay(pdMS_TO_TICKS(COLOUR_HOLD_MS));
    }
}

TEST_CASE("white held at each backlight level, then with the lamp driven flat",
          "[drv_lcd][manual]")
{
    static const uint8_t levels[] = {100, 70, 40, 20, 10, 5, 100};
    panel_up();
    // A static fill with no camera in the picture: flicker seen here belongs to
    // the panel or the lamp, never to the exposure loop (KEHOACH 2.3A).
    TEST_ASSERT_EQUAL(ESP_OK, fill(WHITE));
    for (size_t i = 0; i < sizeof(levels) / sizeof(levels[0]); ++i) {
        TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_backlight(levels[i]));
        printf("  backlight %u%%, hold %d ms and watch the glass\n", levels[i], SWEEP_HOLD_MS);
        vTaskDelay(pdMS_TO_TICKS(SWEEP_HOLD_MS));
    }
    const gpio_config_t flat = {
        .pin_bit_mask = 1ULL << APP_LCD_BLK_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
    };
    // Taking the pad back from ledc leaves the lamp lit with no pwm on it.
    TEST_ASSERT_EQUAL(ESP_OK, gpio_config(&flat));
    TEST_ASSERT_EQUAL(ESP_OK, gpio_set_level(APP_LCD_BLK_GPIO, 1));
    printf("  lamp driven flat, no pwm: watch again for %d ms\n", SWEEP_HOLD_MS * 3);
    vTaskDelay(pdMS_TO_TICKS(SWEEP_HOLD_MS * 3));
}

static void tally(uint32_t *seen, int *count, uint32_t value)
{
    for (int i = 0; i < PROBE_SLOTS; ++i) {
        if (count[i] == 0 || seen[i] == value) {
            seen[i] = value;
            count[i]++;
            return;
        }
    }
    count[PROBE_SLOTS]++;
}

static void report(const char *what, const uint32_t *seen, const int *count)
{
    printf("    %s:", what);
    for (int i = 0; i < PROBE_SLOTS && count[i] > 0; ++i) {
        printf(" %06" PRIx32 " x%d", seen[i], count[i]);
    }
    printf(" | past the table %d\n", count[PROBE_SLOTS]);
}

TEST_CASE("what the panel reports about its own rails, white against black",
          "[drv_lcd][manual]")
{
    static const uint16_t fills[] = {WHITE, 0};
    panel_up();
    TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_backlight(100));
    for (size_t f = 0; f < sizeof(fills) / sizeof(fills[0]); ++f) {
        TEST_ASSERT_EQUAL(ESP_OK, fill(fills[f]));
        uint32_t mode_seen[PROBE_SLOTS] = {0}, test_seen[PROBE_SLOTS] = {0};
        uint32_t id_seen[PROBE_SLOTS] = {0};
        int mode_count[PROBE_SLOTS + 1] = {0}, test_count[PROBE_SLOTS + 1] = {0};
        int id_count[PROBE_SLOTS + 1] = {0};
        const int64_t until = esp_timer_get_time() + (int64_t)PROBE_MS * 1000;
        while (esp_timer_get_time() < until) {
            for (int i = 0; i < PROBE_BURST; ++i) {
                tally(mode_seen, mode_count, read_reg(POWER_MODE_REG));
                tally(test_seen, test_count, read_reg(SELF_TEST_REG));
                tally(id_seen, id_count, read_reg(CHIP_ID_REG));
            }
            vTaskDelay(1);
        }
        printf("  fill %04x\n", fills[f]);
        report("power mode 0x0A", mode_seen, mode_count);
        report("self test  0x0F", test_seen, test_count);
        report("chip id    0xD3", id_seen, id_count);
    }
}

static int shift_that_lands_on_the_id(uint32_t stream)
{
    for (int bit = 0; bit <= 2; ++bit) {
        if (((stream << bit) >> 8) == ST7796S_ID) {
            return bit;
        }
    }
    return -1;
}

TEST_CASE("which read clock and input delay bring the chip id back whole", "[drv_lcd][manual]")
{
    static const int clocks_hz[] = {1000000, 2000000, 3000000, 4000000, 6000000};
    static const int delays_ns[] = {0, 25, 50, 75, 100};
    panel_up();
    TEST_ASSERT_EQUAL(ESP_OK, fill(WHITE));
    printf("  clock  delay   best value  share  shift\n");
    for (size_t c = 0; c < sizeof(clocks_hz) / sizeof(clocks_hz[0]); ++c) {
        for (size_t d = 0; d < sizeof(delays_ns) / sizeof(delays_ns[0]); ++d) {
            spi_device_handle_t reader = NULL;
            TEST_ASSERT_EQUAL(ESP_OK, add_reader(clocks_hz[c], delays_ns[d], &reader));
            uint32_t seen[PROBE_SLOTS] = {0};
            int count[PROBE_SLOTS + 1] = {0};
            for (int i = 0; i < SWEEP_READS; ++i) {
                tally(seen, count, read_stream(reader, CHIP_ID_REG));
            }
            int best = 0;
            for (int i = 1; i < PROBE_SLOTS; ++i) {
                best = count[i] > count[best] ? i : best;
            }
            int actual_hz = 0;
            spi_device_get_actual_freq(reader, &actual_hz);
            printf("  %d asked %6d real %5d ns   %08" PRIx32 "  %3d%%   %d\n",
                   clocks_hz[c] / 1000000, actual_hz, delays_ns[d], seen[best],
                   100 * count[best] / SWEEP_READS, shift_that_lands_on_the_id(seen[best]));
            TEST_ASSERT_EQUAL(ESP_OK, spi_bus_remove_device(reader));
        }
    }
}

static int collect_wraps(void)
{
    int wraps = 0;
    int prev = scan_line();
    const int64_t give_up = esp_timer_get_time() + (int64_t)WRAP_CEILING_MS * 1000;
    while (wraps <= WRAP_FRAMES && esp_timer_get_time() < give_up) {
        const int now = scan_line();
        if (now < 0) {
            continue;
        }
        // A bit flip can fake a wrap, so both ends of the ramp have to agree.
        if (prev > WRAP_LATE && now < WRAP_EARLY) {
            s_wrap_at[wraps++] = esp_timer_get_time();
            vTaskDelay(1);
            prev = scan_line();
            continue;
        }
        prev = now;
    }
    return wraps;
}

TEST_CASE("the panel's own oscillator timed under a white fill and under a black one",
          "[drv_lcd][manual]")
{
    static const uint16_t fills[] = {WHITE, 0};
    panel_up();
    TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_backlight(100));
    for (size_t f = 0; f < sizeof(fills) / sizeof(fills[0]); ++f) {
        TEST_ASSERT_EQUAL(ESP_OK, fill(fills[f]));
        const int wraps = collect_wraps();
        TEST_ASSERT_GREATER_THAN_INT(WRAP_FRAMES / 2, wraps);
        int64_t shortest = INT64_MAX;
        for (int i = 1; i < wraps; ++i) {
            const int64_t period = s_wrap_at[i] - s_wrap_at[i - 1];
            shortest = period < shortest ? period : shortest;
        }
        // A descheduled poll loop misses a wrap and reports two frames as one,
        // so only periods close to the shortest are a frame.
        const int64_t ceiling = shortest + shortest / 10;
        int64_t total = 0, widest = 0;
        int kept = 0;
        for (int i = 1; i < wraps; ++i) {
            const int64_t period = s_wrap_at[i] - s_wrap_at[i - 1];
            if (period <= ceiling) {
                total += period;
                widest = period > widest ? period : widest;
                kept++;
            }
        }
        TEST_ASSERT_GREATER_THAN_INT(0, kept);
        printf("  fill %04x: %d of %d frames kept, mean %lld us, shortest %lld, longest %lld,"
               " spread %lld us\n",
               fills[f], kept, wraps - 1, total / kept, shortest, widest, widest - shortest);
    }
}

TEST_CASE("corner marks name the panel's origin and axis directions", "[drv_lcd]")
{
    // Runs last on purpose: the marks have to survive on the glass for someone
    // to read the axes off them, so no later case may paint over them.
    static const uint16_t colours[] = {RGB565(0xFF, 0, 0), RGB565(0, 0xFF, 0), RGB565(0, 0, 0xFF)};
    const int xs[] = {0, APP_LCD_H_RES - MARK_SIDE, 0};
    const int ys[] = {0, 0, APP_LCD_V_RES - MARK_SIDE};
    const size_t count = sizeof(colours) / sizeof(colours[0]);
    // draw_bitmap returns with the transfer still queued, so each mark keeps its own pixels.
    uint16_t *marks = heap_caps_malloc(count * MARK_PIXELS * sizeof(uint16_t),
                                       MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    TEST_ASSERT_NOT_NULL(marks);
    TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_backlight(100));
    TEST_ASSERT_EQUAL(ESP_OK, fill(0));

    const esp_lcd_panel_handle_t panel = drv_lcd_panel();
    for (size_t i = 0; i < count; ++i) {
        uint16_t *mark = marks + i * MARK_PIXELS;
        const uint16_t panel_order = __builtin_bswap16(colours[i]);
        for (int p = 0; p < MARK_PIXELS; ++p) {
            mark[p] = panel_order;
        }
        TEST_ASSERT_EQUAL(ESP_OK, esp_lcd_panel_draw_bitmap(panel, xs[i], ys[i], xs[i] + MARK_SIDE,
                                                            ys[i] + MARK_SIDE, mark));
    }
    ESP_LOGI(TAG, "red at (0,0), green at x max, blue at y max: read them off the glass");
    vTaskDelay(pdMS_TO_TICKS(MARK_HOLD_MS));
    heap_caps_free(marks);
}

void app_main(void)
{
    // The hand-judged cases go first so the corner marks still end on the glass.
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", false);
    UNITY_END();
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
}
