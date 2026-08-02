cmake_minimum_required(VERSION 3.21)

project(quadruped_simulation_sidecar VERSION 0.1.0 LANGUAGES CXX)

include(CTest)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_library(sidecar_protocol STATIC
  src/protocol.cpp
)
target_include_directories(sidecar_protocol
  PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src"
  SYSTEM PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/third_party"
)

add_executable(quadruped-simulation-sidecar
  src/main.cpp
)
target_link_libraries(quadruped-simulation-sidecar PRIVATE sidecar_protocol)

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
  add_executable(sidecar-protocol-tests tests/protocol_tests.cpp)
  target_link_libraries(sidecar-protocol-tests PRIVATE sidecar_protocol)
  target_include_directories(sidecar-protocol-tests
    SYSTEM PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/third_party"
  )
  if(MSVC)
    target_compile_options(sidecar-protocol-tests PRIVATE /W4 /WX /permissive- /EHsc /utf-8 /external:anglebrackets /external:W0)
  else()
    target_compile_options(sidecar-protocol-tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  endif()
  add_test(NAME sidecar-protocol-tests COMMAND sidecar-protocol-tests)
endif()
