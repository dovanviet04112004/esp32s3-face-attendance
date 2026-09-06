idf_component_register(
    SRCS app_main.c app_tasks.c
    INCLUDE_DIRS "."
    REQUIRES common bsp_board sys_storage ai_engine drv_camera drv_ioexp drv_lcd drv_touch esp_timer
)
