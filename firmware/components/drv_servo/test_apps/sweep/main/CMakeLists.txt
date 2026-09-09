idf_component_register(
    SRCS test_sweep.c
    REQUIRES common bsp_board drv_servo unity
    PRIV_REQUIRES esp_timer esp_driver_gpio
    WHOLE_ARCHIVE
)
