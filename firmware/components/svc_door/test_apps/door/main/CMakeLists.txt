idf_component_register(
    SRCS test_door.c
    REQUIRES common bsp_board drv_servo svc_door unity
    WHOLE_ARCHIVE
)
