idf_component_register(
    SRCS test_tone.c
    REQUIRES common bsp_board drv_ioexp drv_audio unity
    PRIV_REQUIRES esp_timer esp_driver_gpio
    WHOLE_ARCHIVE
)
