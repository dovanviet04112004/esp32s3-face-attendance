idf_component_register(
    SRCS test_facedb.c test_facedb_load.cpp
    REQUIRES common sys_storage svc_facedb unity
    PRIV_REQUIRES esp_timer
    PRIV_INCLUDE_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../../priv_include"
    WHOLE_ARCHIVE
)
