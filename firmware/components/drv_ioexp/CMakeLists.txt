idf_component_register(
    SRCS src/drv_ioexp.c
    INCLUDE_DIRS include
    REQUIRES common bsp_board esp_driver_i2c
    PRIV_REQUIRES log
)
