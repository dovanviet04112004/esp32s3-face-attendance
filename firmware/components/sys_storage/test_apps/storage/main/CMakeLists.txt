idf_component_register(
    SRCS test_storage.c
    REQUIRES common sys_storage bsp_board esp_driver_gpio unity
    WHOLE_ARCHIVE
)
