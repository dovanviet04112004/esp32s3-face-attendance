idf_component_register(
    SRCS test_clock.c
    REQUIRES common bsp_board sys_time unity
    PRIV_REQUIRES esp_timer
    WHOLE_ARCHIVE
)
