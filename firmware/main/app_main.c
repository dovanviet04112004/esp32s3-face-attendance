#include "app_tasks.h"
#include "bsp_board.h"
#include "drv_camera.h"
#include "drv_ioexp.h"
#include "drv_lcd.h"
#include "drv_touch.h"
#include "sys_storage.h"

void app_main(void)
{
    ESP_ERROR_CHECK(sys_storage_init());
    ESP_ERROR_CHECK(bsp_board_init());
    ESP_ERROR_CHECK(drv_lcd_init());
    ESP_ERROR_CHECK(drv_lcd_backlight(100));
    ESP_ERROR_CHECK(drv_ioexp_init());
    ESP_ERROR_CHECK(drv_touch_init());
    ESP_ERROR_CHECK(drv_camera_init());
    ESP_ERROR_CHECK(app_tasks_start());
}
