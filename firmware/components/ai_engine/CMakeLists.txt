idf_component_register(
    SRCS src/ai_engine.cpp src/core/arena.cpp src/core/model_base.cpp src/core/model_store.cpp
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS priv_include
    REQUIRES common sys_storage
    PRIV_REQUIRES log esp_psram espressif__esp-tflite-micro
)
