idf_component_register(
    SRCS src/drv_touch.c
    INCLUDE_DIRS include
    REQUIRES common bsp_board drv_ioexp esp_lcd espressif__esp_lcd_touch_gt911
    PRIV_REQUIRES log esp_driver_gpio
)
