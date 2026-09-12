idf_component_register(
    SRCS test_sensor.c
    REQUIRES common bsp_board drv_camera sys_storage esp_driver_gpio esp_driver_rmt esp_driver_usb_serial_jtag vfs esp_timer unity
    WHOLE_ARCHIVE
)
