idf_component_register(
    SRCS test_facedb.c
    REQUIRES common sys_storage svc_facedb unity
    PRIV_REQUIRES esp_timer
    WHOLE_ARCHIVE
)
