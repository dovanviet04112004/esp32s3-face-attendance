idf_component_register(
    SRCS "src/net_mqtt.c"
    INCLUDE_DIRS "include"
    REQUIRES common sys_storage mqtt
    PRIV_REQUIRES log esp_event
    EMBED_TXTFILES "certs/broker_ca.crt"
)
