cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/third_party")

# The one source of the firmware version (KEHOACH 4.9). It has to be orderable
# because ota_manifest's minFwVersion asks which of two builds is older.
set(PROJECT_VER "0.9.6")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(face_attendance)
