set(FIRMWARE_MAIN "${CMAKE_CURRENT_LIST_DIR}/../../../main")

idf_component_register(
    SRCS soak.c "${FIRMWARE_MAIN}/app_boot.c" "${FIRMWARE_MAIN}/app_tasks.c"
         "${FIRMWARE_MAIN}/app_wiring.c"
    INCLUDE_DIRS "${FIRMWARE_MAIN}"
    REQUIRES common bsp_board sys_storage sys_time net_wifi ai_engine drv_camera drv_ioexp drv_lcd
             drv_touch drv_tof drv_servo svc_facedb svc_vision svc_door svc_attendance unity
             esp_timer esp_system
    WHOLE_ARCHIVE
)
