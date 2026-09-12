idf_component_register(
    SRCS parity.cpp
    REQUIRES common sys_storage ai_engine svc_facedb unity espressif__esp-tflite-micro
    WHOLE_ARCHIVE
)

# The cases compare what the branches compute before a model runs, and those
# entry points live beside the sources rather than in the public header.
target_include_directories(${COMPONENT_LIB} PRIVATE
    "${CMAKE_CURRENT_LIST_DIR}/../../../components/ai_engine/src"
    "${CMAKE_CURRENT_LIST_DIR}/../../../components/ai_engine/priv_include")
