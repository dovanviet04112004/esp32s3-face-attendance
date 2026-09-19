idf_component_register(
    SRCS src/box_tracker.cpp src/canvas.cpp src/theme.cpp src/widgets.cpp src/screens.cpp
         src/ui_kiosk.cpp
         ../../assets/fonts/kiosk_ui_15.c ../../assets/fonts/kiosk_ui_20.c
         ../../assets/fonts/kiosk_ui_24.c ../../assets/fonts/kiosk_ui_28.c
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS priv_include ../../assets/fonts
    REQUIRES common bsp_board drv_lcd sys_storage
    PRIV_REQUIRES log esp_timer
)
