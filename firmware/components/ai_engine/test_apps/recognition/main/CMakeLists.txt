idf_component_register(
    SRCS test_align.c
    REQUIRES common sys_storage ai_engine unity
    PRIV_REQUIRES esp_timer heap
    WHOLE_ARCHIVE
)
