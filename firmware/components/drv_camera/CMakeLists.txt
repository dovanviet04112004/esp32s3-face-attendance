idf_component_register(
    SRCS src/drv_camera.c
    INCLUDE_DIRS include
    REQUIRES common bsp_board espressif__esp32-camera
    PRIV_REQUIRES log esp_timer
)
