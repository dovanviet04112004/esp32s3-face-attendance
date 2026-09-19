idf_component_register(
    SRCS src/net_ota.c
    INCLUDE_DIRS include
    REQUIRES common
    PRIV_REQUIRES app_update esp_http_client esp-tls mbedtls log
)
