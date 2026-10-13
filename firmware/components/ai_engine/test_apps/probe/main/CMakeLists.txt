set(frames "${CMAKE_CURRENT_LIST_DIR}/probe/frames.gold")
if(NOT EXISTS "${frames}")
    message(FATAL_ERROR "${frames} is missing: make ai-probe writes it from a ladder row")
endif()

idf_component_register(
    SRCS test_probe.cpp
    REQUIRES common sys_storage ai_engine unity esp_timer esp_driver_usb_serial_jtag esp_psram heap espressif__esp-dl
    EMBED_FILES "${frames}"
    WHOLE_ARCHIVE
)

# The probe builds dl::Model itself, so it registers ai_engine's own modules first (KEHOACH 3.7).
idf_component_get_property(engine_dir ai_engine COMPONENT_DIR)
target_include_directories(${COMPONENT_LIB} PRIVATE "${engine_dir}/priv_include")
