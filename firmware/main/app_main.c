#include "bsp_board.h"
#include "drv_ioexp.h"
#include "drv_lcd.h"
#include "drv_touch.h"

#define TOUCH_WATCH_SECONDS 10

void app_main(void)
{
    ESP_ERROR_CHECK(bsp_board_init());
    ESP_ERROR_CHECK(drv_lcd_init());
    ESP_ERROR_CHECK(drv_lcd_backlight(100));
    ESP_ERROR_CHECK(drv_lcd_selftest());
    ESP_ERROR_CHECK(drv_ioexp_init());
    bsp_i2c_scan();
    ESP_ERROR_CHECK(drv_touch_init());
    ESP_ERROR_CHECK(drv_touch_selftest(TOUCH_WATCH_SECONDS));
}
