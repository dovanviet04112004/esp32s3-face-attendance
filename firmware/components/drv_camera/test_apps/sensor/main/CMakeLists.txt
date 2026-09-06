idf_component_register(
    SRCS test_sensor.c
    REQUIRES common bsp_board drv_camera esp_timer unity
    WHOLE_ARCHIVE
)
