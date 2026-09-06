idf_component_register(
    SRCS test_spoof.c
    REQUIRES common sys_storage ai_engine unity esp_timer
    WHOLE_ARCHIVE
)
