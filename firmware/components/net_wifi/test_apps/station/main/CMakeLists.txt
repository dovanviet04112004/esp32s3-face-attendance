idf_component_register(
    SRCS test_station.c
    REQUIRES common sys_storage net_wifi unity
    PRIV_REQUIRES esp_timer
    WHOLE_ARCHIVE
)
