#include "bsp_board.h"
#include "drv_lcd.h"

void app_main(void)
{
    ESP_ERROR_CHECK(bsp_board_init());
    ESP_ERROR_CHECK(drv_lcd_init());
    ESP_ERROR_CHECK(drv_lcd_backlight(100));
    ESP_ERROR_CHECK(drv_lcd_selftest());
    bsp_i2c_scan();
}
