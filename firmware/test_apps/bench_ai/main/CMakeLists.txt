idf_component_register(
    SRCS bench_ai.c espdl_graphs.cpp
    REQUIRES common sys_storage ai_engine unity esp_timer espressif__esp-dl
    WHOLE_ARCHIVE
)
