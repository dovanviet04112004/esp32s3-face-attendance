idf_component_register(
    SRCS test_touch.c
    REQUIRES common bsp_board drv_ioexp drv_touch unity
    WHOLE_ARCHIVE
)
