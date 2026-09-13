idf_component_register(
    SRCS src/box_tracker.cpp src/overlay.cpp src/ui_kiosk.cpp
         ../../assets/fonts/kiosk_sans_22.c
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS priv_include ../../assets/fonts
    REQUIRES common bsp_board drv_lcd sys_storage
    PRIV_REQUIRES log esp_timer
)
