idf_component_register(
    SRCS src/drv_tof.c src/vl53l1_platform.c
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS priv_include
    REQUIRES common bsp_board drv_ioexp vl53l1x_uld esp_driver_gpio esp_driver_i2c
    PRIV_REQUIRES log
)
