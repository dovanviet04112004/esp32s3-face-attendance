cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../../")
set(COMPONENTS main common sys_storage unity)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(sys_storage_test)
