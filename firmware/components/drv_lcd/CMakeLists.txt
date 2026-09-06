idf_component_register(
    SRCS src/drv_lcd.c
    INCLUDE_DIRS include
    REQUIRES common bsp_board esp_lcd esp_driver_ledc
    PRIV_REQUIRES log esp_mm espressif__esp_lcd_st7796
)
