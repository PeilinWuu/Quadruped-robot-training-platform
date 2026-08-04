cmake_minimum_required(VERSION 3.21)

project(quadruped_simulation_sidecar VERSION 0.1.0 LANGUAGES CXX)

include(CTest)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

if(NOT DEFINED MUJOCO_ROOT)
  message(FATAL_ERROR "MUJOCO_ROOT must point to the verified project-local MuJoCo 3.11.0 cache")
endif()
cmake_path(ABSOLUTE_PATH MUJOCO_ROOT NORMALIZE OUTPUT_VARIABLE MUJOCO_ROOT_ABSOLUTE)
set(MUJOCO_INCLUDE_DIR "${MUJOCO_ROOT_ABSOLUTE}/include")
set(MUJOCO_IMPORT_LIBRARY "${MUJOCO_ROOT_ABSOLUTE}/lib/mujoco.lib")
set(MUJOCO_RUNTIME_LIBRARY "${MUJOCO_ROOT_ABSOLUTE}/bin/mujoco.dll")
foreach(required "${MUJOCO_INCLUDE_DIR}/mujoco/mujoco.h" "${MUJOCO_IMPORT_LIBRARY}" "${MUJOCO_RUNTIME_LIBRARY}")
  if(NOT EXISTS "${required}")
    message(FATAL_ERROR "Verified MuJoCo cache file is missing: ${required}")
  endif()
endforeach()

add_library(mujoco_imported SHARED IMPORTED GLOBAL)
set_target_properties(mujoco_imported PROPERTIES
  IMPORTED_IMPLIB "${MUJOCO_IMPORT_LIBRARY}"
  IMPORTED_LOCATION "${MUJOCO_RUNTIME_LIBRARY}"
  INTERFACE_INCLUDE_DIRECTORIES "${MUJOCO_INCLUDE_DIR}"
)

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
endif()
