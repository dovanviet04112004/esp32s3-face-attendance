idf_component_register(
    SRCS test_expander.c
    REQUIRES common bsp_board drv_ioexp unity
    WHOLE_ARCHIVE
)
