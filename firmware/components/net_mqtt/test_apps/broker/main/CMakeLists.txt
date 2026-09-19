idf_component_register(
    SRCS test_broker.c
    REQUIRES common sys_storage net_wifi net_mqtt unity
    PRIV_REQUIRES esp_timer
    WHOLE_ARCHIVE
)
