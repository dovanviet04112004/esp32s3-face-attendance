cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../components")
set(COMPONENTS main common sys_storage ai_engine svc_facedb unity)

# The board is one board: test apps take its clock, cache and psram
# settings from the same file the firmware does.
set(SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/../../sdkconfig.defaults.esp32s3"
                       "${CMAKE_CURRENT_LIST_DIR}/sdkconfig.defaults"
                       $ENV{SDKCONFIG_DEFAULTS})

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(parity)

# The cases the host wrote are flashed with the app, so the board opens them
# from /lfs as ordinary files and needs no transfer of its own.
littlefs_create_partition_image(storage "${CMAKE_CURRENT_LIST_DIR}/../../../contracts/golden"
                                FLASH_IN_PROJECT)
