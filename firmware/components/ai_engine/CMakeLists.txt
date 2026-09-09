idf_component_register(
    SRCS src/ai_engine.cpp src/core/arena.cpp src/core/model_base.cpp src/core/model_store.cpp
         src/core/profiler.cpp src/core/pixels.cpp
         src/antispoof/ops.cpp src/antispoof/spoof_model.cpp src/antispoof/preproc.cpp
         src/detection/ops.cpp src/detection/decode.cpp src/detection/nms.cpp src/detection/letterbox.cpp
         src/recognition/ops.cpp src/recognition/recog_model.cpp src/recognition/align.cpp
         src/recognition/l2norm.cpp
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS priv_include src
    REQUIRES common sys_storage
    PRIV_REQUIRES log esp_psram espressif__esp-tflite-micro
)
