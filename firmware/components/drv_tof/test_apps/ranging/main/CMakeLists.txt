idf_component_register(
    SRCS test_ranging.c
    REQUIRES common bsp_board drv_ioexp drv_tof unity
    PRIV_REQUIRES esp_timer
    WHOLE_ARCHIVE
)
