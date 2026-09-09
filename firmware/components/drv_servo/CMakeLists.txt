idf_component_register(
    SRCS src/drv_servo.c
    INCLUDE_DIRS include
    REQUIRES common bsp_board esp_driver_ledc
    PRIV_REQUIRES log
)
