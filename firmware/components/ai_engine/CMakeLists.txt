# Built on either runtime: TensorView, the pixel work and every branch's pre- and post-processing.
set(srcs src/core/pixels.cpp
         src/antispoof/live_score.cpp src/antispoof/preproc.cpp
         src/detection/decode.cpp src/detection/nms.cpp src/detection/letterbox.cpp
         src/recognition/align.cpp src/recognition/l2norm.cpp)

# A tflm/ or espdl/ folder builds on its own runtime alone, so ai_engine.h has one definition (KEHOACH 4.5.6).
if(CONFIG_AI_RUNTIME_ESPDL)
    list(APPEND srcs src/ai_engine_espdl.cpp
                     src/core/espdl/espdl_model.cpp src/core/espdl/espdl_conv_prelu.cpp
                     src/core/espdl/espdl_conv_slices.cpp src/core/espdl/espdl_channel_conv.cpp
                     src/core/espdl/espdl_conv_im2col.cpp src/core/espdl/espdl_mul_add.cpp
                     src/core/espdl/espdl_pointwise_depthwise.cpp src/core/espdl/espdl_spatial_mean.cpp
                     src/core/espdl/clamp_s8_esp32s3.S src/core/espdl/max_pool_s8_esp32s3.S
                     src/core/espdl/mul_add_s8_esp32s3.S src/core/espdl/conv_row_s8_esp32s3.S)
else()
    list(APPEND srcs src/ai_engine_tflm.cpp
                     src/core/tflm/arena.cpp src/core/tflm/model_base.cpp src/core/tflm/model_store.cpp
                     src/core/tflm/profiler.cpp
                     src/antispoof/tflm/ops.cpp src/detection/tflm/ops.cpp src/recognition/tflm/ops.cpp)
endif()

# IDF expands requirements before it reads Kconfig, so both libraries stay required
# although only the chosen runtime's sources call one (KEHOACH 4.5.6).
idf_component_register(
    SRCS ${srcs}
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS src
    REQUIRES common sys_storage
    PRIV_REQUIRES log esp_psram esp_timer espressif__esp-tflite-micro espressif__esp-dl
)
