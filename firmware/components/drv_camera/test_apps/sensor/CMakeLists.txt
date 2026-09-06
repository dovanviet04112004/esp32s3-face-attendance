cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../../")
set(COMPONENTS main common bsp_board drv_camera esp_timer unity)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(drv_camera_test)
