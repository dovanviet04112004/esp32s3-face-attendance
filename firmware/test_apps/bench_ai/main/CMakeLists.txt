idf_component_register(
    SRCS bench_ai.c
    REQUIRES common sys_storage ai_engine unity esp_timer
    WHOLE_ARCHIVE
)
