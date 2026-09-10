idf_component_register(
    SRCS app_main.c app_tasks.c app_wiring.c
    INCLUDE_DIRS "."
    REQUIRES common bsp_board sys_storage sys_time net_wifi ai_engine drv_camera drv_ioexp drv_lcd
             drv_touch drv_tof drv_servo svc_facedb svc_vision svc_door svc_attendance esp_timer esp_system
)
