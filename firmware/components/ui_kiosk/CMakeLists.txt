idf_component_register(
    SRCS src/box_tracker.cpp
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS priv_include
    REQUIRES common
    PRIV_REQUIRES log
)
