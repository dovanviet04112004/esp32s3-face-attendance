set(frames "${CMAKE_CURRENT_LIST_DIR}/probe/frames.gold")
if(NOT EXISTS "${frames}")
    message(FATAL_ERROR "${frames} is missing: make ai-probe writes it from a ladder row")
endif()

idf_component_register(
    SRCS test_probe.cpp
    REQUIRES common sys_storage ai_engine unity esp_timer esp_driver_usb_serial_jtag espressif__esp-dl
    EMBED_FILES "${frames}"
    WHOLE_ARCHIVE
)
