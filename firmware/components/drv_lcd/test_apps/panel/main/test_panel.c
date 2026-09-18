#include "app_config.h"
#include "bsp_board.h"
#include "driver/gpio.h"
#include "drv_lcd.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include <inttypes.h>
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
#define CHIP_ID_REG 0xD3
#define PROBE_MS 6000
#define PROBE_BURST 200
#define PROBE_SLOTS 5

// The hand-judged cases run first, so they cannot lean on the case below.
static void panel_up(void)
{
    const esp_err_t board = bsp_board_init();
    TEST_ASSERT_TRUE(board == ESP_OK || board == ESP_ERR_INVALID_STATE);
    const esp_err_t lcd = drv_lcd_init();
    TEST_ASSERT_TRUE(lcd == ESP_OK || lcd == ESP_ERR_INVALID_STATE);
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
    // The line comes from the DMA-capable heap on every call, so a leak here
    // shows up as a fill that stops succeeding.
    const size_t before = heap_caps_get_free_size(MALLOC_CAP_DMA);
    for (int i = 0; i < 16; ++i) {
        TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_fill(WHITE));
    }
    const size_t after = heap_caps_get_free_size(MALLOC_CAP_DMA);
    TEST_ASSERT_EQUAL(before, after);
}

TEST_CASE("the panel stands portrait, taller than it is wide", "[drv_lcd]")
{
    TEST_ASSERT_EQUAL(320, APP_LCD_H_RES);
    TEST_ASSERT_EQUAL(480, APP_LCD_V_RES);
}

TEST_CASE("an empty window is refused rather than divided by", "[drv_lcd]")
{
    uint16_t pixel = 0;
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_SIZE, drv_lcd_blit(0, 0, 0, 1, &pixel));
    TEST_ASSERT_EQUAL(ESP_ERR_INVALID_SIZE, drv_lcd_blit(0, 0, 1, 0, &pixel));
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
        TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_fill(colours[i]));
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
    TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_fill(WHITE));
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
        TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_fill(fills[f]));
        uint32_t mode_seen[PROBE_SLOTS] = {0}, test_seen[PROBE_SLOTS] = {0};
        uint32_t id_seen[PROBE_SLOTS] = {0};
        int mode_count[PROBE_SLOTS + 1] = {0}, test_count[PROBE_SLOTS + 1] = {0};
        int id_count[PROBE_SLOTS + 1] = {0};
        const int64_t until = esp_timer_get_time() + (int64_t)PROBE_MS * 1000;
        while (esp_timer_get_time() < until) {
            for (int i = 0; i < PROBE_BURST; ++i) {
                tally(mode_seen, mode_count, drv_lcd_read_reg(POWER_MODE_REG));
                tally(test_seen, test_count, drv_lcd_read_reg(SELF_TEST_REG));
                tally(id_seen, id_count, drv_lcd_read_reg(CHIP_ID_REG));
            }
            vTaskDelay(1);
        }
        printf("  fill %04x\n", fills[f]);
        report("power mode 0x0A", mode_seen, mode_count);
        report("self test  0x0F", test_seen, test_count);
        report("chip id    0xD3", id_seen, id_count);
    }
}

TEST_CASE("corner marks name the panel's origin and axis directions", "[drv_lcd]")
{
    // Runs last on purpose: the marks have to survive on the glass for someone
    // to read the axes off them, so no later case may paint over them.
    uint16_t *mark = heap_caps_malloc(MARK_PIXELS * sizeof(uint16_t), MALLOC_CAP_INTERNAL);
    TEST_ASSERT_NOT_NULL(mark);
    TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_backlight(100));
    TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_fill(0));

    const uint16_t colours[] = {RGB565(0xFF, 0, 0), RGB565(0, 0xFF, 0), RGB565(0, 0, 0xFF)};
    const int xs[] = {0, APP_LCD_H_RES - MARK_SIDE, 0};
    const int ys[] = {0, 0, APP_LCD_V_RES - MARK_SIDE};
    for (int i = 0; i < 3; ++i) {
        for (int p = 0; p < MARK_PIXELS; ++p) {
            mark[p] = colours[i];
        }
        TEST_ASSERT_EQUAL(ESP_OK,
                          drv_lcd_blit(xs[i], ys[i], xs[i] + MARK_SIDE, ys[i] + MARK_SIDE, mark));
    }
    heap_caps_free(mark);
    ESP_LOGI(TAG, "red at (0,0), green at x max, blue at y max: read them off the glass");
    vTaskDelay(pdMS_TO_TICKS(MARK_HOLD_MS));
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
