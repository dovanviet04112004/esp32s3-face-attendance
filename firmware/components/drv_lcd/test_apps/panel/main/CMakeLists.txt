idf_component_register(
    SRCS test_panel.c
    REQUIRES common bsp_board drv_lcd unity
    WHOLE_ARCHIVE
)
