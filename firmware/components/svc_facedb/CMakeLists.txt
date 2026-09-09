idf_component_register(
    SRCS src/facedb.cpp src/embedding_index.cpp src/persist.cpp src/svc_facedb.cpp
         src/dot_s8_esp32s3.S
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS priv_include
    REQUIRES common sys_storage
    PRIV_REQUIRES log heap
)
