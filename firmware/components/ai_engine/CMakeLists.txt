idf_component_register(
    SRCS src/ai_engine.cpp src/core/arena.cpp src/core/model_base.cpp src/core/model_store.cpp
         src/core/profiler.cpp
         src/antispoof/ops.cpp src/antispoof/spoof_model.cpp
         src/detection/ops.cpp
         src/recognition/ops.cpp src/recognition/recog_model.cpp
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS priv_include src
    REQUIRES common sys_storage
    PRIV_REQUIRES log esp_psram espressif__esp-tflite-micro
)
