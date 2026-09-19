idf_component_register(
    SRCS test_uplink.cpp
    REQUIRES common svc_sync unity esp_driver_usb_serial_jtag
    PRIV_INCLUDE_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../../priv_include"
    PRIV_REQUIRES espressif__cjson
    WHOLE_ARCHIVE
)
