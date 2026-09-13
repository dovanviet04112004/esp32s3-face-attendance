idf_component_register(
    SRCS src/box_tracker.cpp src/overlay.cpp src/ui_kiosk.cpp
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS priv_include
    REQUIRES common bsp_board drv_lcd
    PRIV_REQUIRES log esp_timer
)
