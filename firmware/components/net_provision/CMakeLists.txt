idf_component_register(
    SRCS src/net_provision.c
    INCLUDE_DIRS include
    REQUIRES common sys_storage
    PRIV_REQUIRES sys_time esp_timer esp_http_client esp-tls mbedtls esp_app_format espressif__cjson log
)
