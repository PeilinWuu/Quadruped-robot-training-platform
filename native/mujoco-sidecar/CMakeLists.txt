cmake_minimum_required(VERSION 3.21)

project(quadruped_simulation_sidecar VERSION 0.1.0 LANGUAGES C CXX)

include(CTest)
option(D6_NATIVE_VIEWER_POC_BUILD "Build the Linux development-only native viewer POC" OFF)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT DEFINED MUJOCO_ROOT)
  message(FATAL_ERROR "MUJOCO_ROOT must point to the verified project-local MuJoCo 3.11.0 cache")
endif()
cmake_path(ABSOLUTE_PATH MUJOCO_ROOT NORMALIZE OUTPUT_VARIABLE MUJOCO_ROOT_ABSOLUTE)
set(MUJOCO_INCLUDE_DIR "${MUJOCO_ROOT_ABSOLUTE}/include")
if(WIN32)
  set(MUJOCO_LINK_LIBRARY "${MUJOCO_ROOT_ABSOLUTE}/lib/mujoco.lib")
  set(MUJOCO_RUNTIME_LIBRARY "${MUJOCO_ROOT_ABSOLUTE}/bin/mujoco.dll")
else()
  set(MUJOCO_LINK_LIBRARY "${MUJOCO_ROOT_ABSOLUTE}/lib/libmujoco.so")
  set(MUJOCO_RUNTIME_LIBRARY "${MUJOCO_ROOT_ABSOLUTE}/lib/libmujoco.so.3.11.0")
endif()
foreach(required "${MUJOCO_INCLUDE_DIR}/mujoco/mujoco.h" "${MUJOCO_LINK_LIBRARY}" "${MUJOCO_RUNTIME_LIBRARY}")
  if(NOT EXISTS "${required}")
    message(FATAL_ERROR "Verified MuJoCo cache file is missing: ${required}")
  endif()
endforeach()

add_library(mujoco_imported SHARED IMPORTED GLOBAL)
if(WIN32)
  set_target_properties(mujoco_imported PROPERTIES IMPORTED_IMPLIB "${MUJOCO_LINK_LIBRARY}")
endif()
set_target_properties(mujoco_imported PROPERTIES IMPORTED_LOCATION "${MUJOCO_RUNTIME_LIBRARY}")
target_include_directories(mujoco_imported SYSTEM INTERFACE "${MUJOCO_INCLUDE_DIR}")

add_library(sidecar_protocol STATIC
  src/protocol.cpp
  src/simulation.cpp
)
target_include_directories(sidecar_protocol
  PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src"
  SYSTEM PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/third_party"
)

add_executable(quadruped-simulation-sidecar
  src/main.cpp
)
target_link_libraries(sidecar_protocol PUBLIC mujoco_imported)
target_link_libraries(quadruped-simulation-sidecar PRIVATE sidecar_protocol)
if(D6_NATIVE_VIEWER_POC_BUILD)
  if(NOT UNIX OR APPLE)
    message(FATAL_ERROR "D6 native viewer POC is Linux-only")
  endif()
  find_package(glfw3 3.3 REQUIRED)
  target_sources(sidecar_protocol PRIVATE src/native_viewer.cpp)
  target_compile_definitions(sidecar_protocol PUBLIC D6_NATIVE_VIEWER_POC_BUILD=1)
  target_link_libraries(sidecar_protocol PRIVATE glfw)
endif()
if(UNIX AND NOT APPLE)
  set_target_properties(quadruped-simulation-sidecar PROPERTIES
    BUILD_WITH_INSTALL_RPATH ON
    INSTALL_RPATH "$ORIGIN"
  )
endif()
add_custom_command(TARGET quadruped-simulation-sidecar POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different "${MUJOCO_RUNTIME_LIBRARY}" "$<TARGET_FILE_DIR:quadruped-simulation-sidecar>"
)

if(MSVC)
  foreach(target sidecar_protocol quadruped-simulation-sidecar)
    target_compile_options(${target} PRIVATE /W4 /WX /permissive- /EHsc /utf-8 /external:anglebrackets /external:W0)
  endforeach()
else()
  foreach(target sidecar_protocol quadruped-simulation-sidecar)
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror)
  endforeach()
endif()

if(BUILD_TESTING)
  target_compile_definitions(sidecar_protocol PUBLIC SIDECAR_TESTING=1)
  add_executable(sidecar-protocol-tests tests/protocol_tests.cpp)
  target_link_libraries(sidecar-protocol-tests PRIVATE sidecar_protocol)
  target_include_directories(sidecar-protocol-tests
    SYSTEM PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/third_party"
  )
  target_compile_definitions(sidecar-protocol-tests PRIVATE TEST_RESOURCE_ROOT="${CMAKE_SOURCE_DIR}/../../src-tauri")
  add_custom_command(TARGET sidecar-protocol-tests POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${MUJOCO_RUNTIME_LIBRARY}" "$<TARGET_FILE_DIR:sidecar-protocol-tests>"
  )
  if(MSVC)
    target_compile_options(sidecar-protocol-tests PRIVATE /W4 /WX /permissive- /EHsc /utf-8 /external:anglebrackets /external:W0)
  else()
    target_compile_options(sidecar-protocol-tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  endif()
  add_test(NAME sidecar-protocol-tests COMMAND sidecar-protocol-tests)
  set_tests_properties(sidecar-protocol-tests PROPERTIES
    ENVIRONMENT "D6_NATIVE_MUJOCO_VIEWER_POC=0"
  )

endif()
