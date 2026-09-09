cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../../"
                         "${CMAKE_CURRENT_LIST_DIR}/../../../../third_party")
set(COMPONENTS main common bsp_board drv_ioexp drv_tof vl53l1x_uld unity)

# The board is one board: test apps take its clock, cache and psram
# settings from the same file the firmware does.
set(SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/../../../../sdkconfig.defaults.esp32s3"
                       "${CMAKE_CURRENT_LIST_DIR}/sdkconfig.defaults"
                       $ENV{SDKCONFIG_DEFAULTS})

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(drv_tof_test)
