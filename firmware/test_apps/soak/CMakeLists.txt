cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../components"
                         "${CMAKE_CURRENT_LIST_DIR}/../../third_party")
set(COMPONENTS main common bsp_board sys_storage sys_time net_wifi ai_engine drv_camera drv_ioexp
               drv_lcd drv_touch drv_tof drv_servo svc_facedb svc_vision svc_door svc_attendance
               vl53l1x_uld unity)

# The board is one board: test apps take its clock, cache and psram
# settings from the same file the firmware does.
set(SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/../../sdkconfig.defaults.esp32s3"
                       "${CMAKE_CURRENT_LIST_DIR}/sdkconfig.defaults"
                       "${CMAKE_CURRENT_LIST_DIR}/../../sdkconfig.dev"
                       $ENV{SDKCONFIG_DEFAULTS})

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(soak)
