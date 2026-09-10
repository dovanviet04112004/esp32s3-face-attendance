idf_component_register(
    SRCS "src/sys_time.c"
    INCLUDE_DIRS "include"
    REQUIRES common bsp_board
    PRIV_REQUIRES esp_driver_i2c lwip esp_netif
)
