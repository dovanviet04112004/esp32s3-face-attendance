idf_component_register(
    SRCS test_ota.c
    REQUIRES common sys_storage net_ota unity
    PRIV_REQUIRES esp_timer esp_netif
    WHOLE_ARCHIVE
)
