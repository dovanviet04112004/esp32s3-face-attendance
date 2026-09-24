idf_component_register(
    SRCS test_register.c
    REQUIRES common sys_storage net_wifi net_provision unity
    WHOLE_ARCHIVE
)
