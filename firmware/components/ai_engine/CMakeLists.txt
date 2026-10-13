set(srcs src/core/pixels.cpp
         src/antispoof/spoof_model.cpp src/antispoof/preproc.cpp
         src/detection/decode.cpp src/detection/nms.cpp src/detection/letterbox.cpp
         src/recognition/align.cpp src/recognition/l2norm.cpp)

# Only the chosen runtime's facade is compiled, so ai_engine.h has one definition
# and only that runtime's library is pulled in at link (KEHOACH 4.5.6).
if(CONFIG_AI_RUNTIME_ESPDL)
    list(APPEND srcs src/ai_engine_espdl.cpp src/core/espdl_model.cpp src/core/espdl_conv_prelu.cpp
                     src/core/espdl_conv_slices.cpp src/core/espdl_channel_conv.cpp
                     src/core/espdl_conv_im2col.cpp src/core/espdl_mul_add.cpp
                     src/core/espdl_pointwise_depthwise.cpp src/core/espdl_spatial_mean.cpp
                     src/core/clamp_s8_esp32s3.S
                     src/core/max_pool_s8_esp32s3.S src/core/mul_add_s8_esp32s3.S
                     src/core/conv_row_s8_esp32s3.S)
else()
    list(APPEND srcs src/ai_engine.cpp src/core/arena.cpp src/core/model_base.cpp src/core/model_store.cpp
                     src/core/profiler.cpp
                     src/antispoof/ops.cpp src/detection/ops.cpp src/recognition/ops.cpp)
endif()

idf_component_register(
    SRCS ${srcs}
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS priv_include src
    REQUIRES common sys_storage
    PRIV_REQUIRES log esp_psram esp_timer espressif__esp-tflite-micro espressif__esp-dl
)
