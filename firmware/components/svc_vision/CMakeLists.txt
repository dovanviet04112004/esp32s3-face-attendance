idf_component_register(
    SRCS src/pipeline.cpp src/backends.cpp src/svc_vision.cpp
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS priv_include
    REQUIRES common ai_engine svc_facedb drv_camera
    PRIV_REQUIRES log heap
)
