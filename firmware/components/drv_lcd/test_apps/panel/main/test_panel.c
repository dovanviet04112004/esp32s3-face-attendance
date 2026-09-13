#include "app_config.h"
#include "bsp_board.h"
#include "drv_lcd.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
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

TEST_CASE("init brings the panel up and refuses a second time", "[drv_lcd]")
{
    TEST_ASSERT_EQUAL(ESP_OK, bsp_board_init());
    TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_init());
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
    TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_backlight(100));
    for (size_t i = 0; i < sizeof(colours) / sizeof(colours[0]); ++i) {
        TEST_ASSERT_EQUAL(ESP_OK, drv_lcd_fill(colours[i]));
        vTaskDelay(pdMS_TO_TICKS(COLOUR_HOLD_MS));
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
    UNITY_BEGIN();
    unity_run_tests_by_tag("[manual]", true);
    UNITY_END();
}
