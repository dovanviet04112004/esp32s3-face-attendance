idf_component_register(
    SRCS test_decode.c
    REQUIRES common sys_storage ai_engine unity
    PRIV_REQUIRES esp_timer heap
    WHOLE_ARCHIVE
)
