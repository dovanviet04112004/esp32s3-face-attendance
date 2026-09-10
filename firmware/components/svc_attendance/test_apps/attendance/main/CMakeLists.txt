idf_component_register(
    SRCS test_attendance.c
    REQUIRES common sys_storage svc_door svc_attendance unity
    WHOLE_ARCHIVE
)
