idf_component_register(
    SRCS test_panel.c
    REQUIRES common bsp_board drv_lcd esp_timer unity
    WHOLE_ARCHIVE
)
