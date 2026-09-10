idf_component_register(
    SRCS test_tracker.cpp
    REQUIRES common ui_kiosk unity
    PRIV_REQUIRES esp_timer heap
    PRIV_INCLUDE_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../../priv_include"
    WHOLE_ARCHIVE
)
