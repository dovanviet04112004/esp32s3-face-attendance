idf_component_register(
    SRCS src/drv_audio.c
    INCLUDE_DIRS include
    REQUIRES common bsp_board drv_ioexp esp_driver_i2s
    PRIV_REQUIRES log
)
