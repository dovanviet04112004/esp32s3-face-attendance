idf_component_register(
    SRCS "src/svc_attendance.cpp" "src/fsm.cpp"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "priv_include"
    REQUIRES common svc_vision svc_door sys_storage sys_time
    PRIV_REQUIRES esp_hw_support
)
