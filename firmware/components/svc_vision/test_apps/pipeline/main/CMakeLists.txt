idf_component_register(
    SRCS test_pipeline.cpp
    REQUIRES common svc_vision unity esp_driver_usb_serial_jtag
    PRIV_INCLUDE_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../../priv_include"
    WHOLE_ARCHIVE
)
