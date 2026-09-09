idf_component_register(
    SRCS src/svc_door.cpp src/servo_door.cpp src/fake_door.cpp
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS priv_include
    REQUIRES common bsp_board drv_servo
    PRIV_REQUIRES log esp_timer
)
