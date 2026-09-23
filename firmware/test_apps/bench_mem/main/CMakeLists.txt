set(FIRMWARE_MAIN "${CMAKE_CURRENT_LIST_DIR}/../../../main")

idf_component_register(
    SRCS bench_mem.c "${FIRMWARE_MAIN}/app_boot.c" "${FIRMWARE_MAIN}/app_tasks.c"
         "${FIRMWARE_MAIN}/app_wiring.c"
    INCLUDE_DIRS "${FIRMWARE_MAIN}"
    REQUIRES common bsp_board sys_storage sys_time net_wifi net_mqtt net_ota svc_sync ai_engine drv_audio drv_camera drv_ioexp
             drv_lcd drv_touch drv_tof drv_servo svc_facedb svc_vision svc_door svc_attendance
             ui_kiosk unity esp_timer esp_system esp_app_format espressif__cjson mbedtls
    WHOLE_ARCHIVE
)
