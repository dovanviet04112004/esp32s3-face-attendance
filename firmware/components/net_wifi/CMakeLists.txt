idf_component_register(
    SRCS "src/net_wifi.c"
    INCLUDE_DIRS "include"
    REQUIRES common sys_storage esp_wifi
    PRIV_REQUIRES esp_netif esp_event esp_timer
)
