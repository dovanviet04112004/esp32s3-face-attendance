idf_component_register(
    SRCS src/svc_sync.cpp src/uplink.cpp src/persist.cpp src/link.cpp
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS priv_include
    REQUIRES common sys_storage net_mqtt
    PRIV_REQUIRES log espressif__cjson
)
