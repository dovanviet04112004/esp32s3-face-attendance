idf_component_register(
    SRCS src/bsp_board.c
    INCLUDE_DIRS include
    REQUIRES common driver esp_driver_gpio esp_driver_i2c esp_driver_spi esp_driver_ledc
    PRIV_REQUIRES log
)
