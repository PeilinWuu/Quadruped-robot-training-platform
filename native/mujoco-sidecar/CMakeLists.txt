cmake_minimum_required(VERSION 3.21)

project(quadruped_simulation_sidecar VERSION 0.1.0 LANGUAGES C CXX)

include(CTest)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

if(NOT DEFINED MUJOCO_ROOT)
  message(FATAL_ERROR "MUJOCO_ROOT must point to the verified project-local MuJoCo 3.11.0 cache")
endif()
foreach(dependency EIGEN_ROOT OSQP_ROOT QDLDL_ROOT)
  if(NOT DEFINED ${dependency})
    message(FATAL_ERROR "${dependency} must point to the verified project-local D5V MPC dependency cache")
  endif()
  cmake_path(ABSOLUTE_PATH ${dependency} NORMALIZE OUTPUT_VARIABLE ${dependency}_ABSOLUTE)
endforeach()
if(NOT EXISTS "${EIGEN_ROOT_ABSOLUTE}/Eigen/Core" OR
   NOT EXISTS "${OSQP_ROOT_ABSOLUTE}/include/public/osqp.h" OR
   NOT EXISTS "${QDLDL_ROOT_ABSOLUTE}/include/qdldl.h")
  message(FATAL_ERROR "Verified D5V MPC dependency cache is incomplete")
endif()

set(FETCHCONTENT_FULLY_DISCONNECTED ON CACHE BOOL "Never fetch MPC dependencies during a normal build" FORCE)
set(FETCHCONTENT_SOURCE_DIR_QDLDL "${QDLDL_ROOT_ABSOLUTE}" CACHE PATH "Pinned local QDLDL source" FORCE)
set(OSQP_BUILD_SHARED_LIB OFF CACHE BOOL "No OSQP runtime DLL" FORCE)
set(OSQP_BUILD_STATIC_LIB ON CACHE BOOL "Static OSQP C API" FORCE)
set(OSQP_BUILD_DEMO_EXE OFF CACHE BOOL "No OSQP demo" FORCE)
set(OSQP_BUILD_UNITTESTS OFF CACHE BOOL "Project tests cover the integration" FORCE)
set(OSQP_CODEGEN OFF CACHE BOOL "No generated runtime" FORCE)
set(OSQP_ENABLE_DERIVATIVES OFF CACHE BOOL "No derivative API" FORCE)
set(OSQP_ENABLE_PRINTING OFF CACHE BOOL "No solver console output" FORCE)
set(OSQP_ENABLE_PROFILING ON CACHE BOOL "Collect bounded solver timings" FORCE)
set(OSQP_ENABLE_INTERRUPT OFF CACHE BOOL "No process-global signal handlers" FORCE)
set(OSQP_ALGEBRA_BACKEND builtin CACHE STRING "Builtin QDLDL only" FORCE)
add_subdirectory("${OSQP_ROOT_ABSOLUTE}" "${CMAKE_BINARY_DIR}/_deps/osqp" EXCLUDE_FROM_ALL)
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
  src/controllers/mpc/centroidal_dynamics.cpp
  src/controllers/mpc/base_reference_generator.cpp
  src/controllers/mpc/convex_mpc.cpp
  src/controllers/mpc/foothold_planner.cpp
  src/controllers/mpc/gait_generator.cpp
  src/controllers/mpc/go2_convex_mpc_controller.cpp
  src/controllers/mpc/leg_controller.cpp
  src/controllers/mpc/mujoco_state_provider.cpp
  src/controllers/mpc/osqp_solver.cpp
  src/controllers/mpc/swing_trajectory.cpp
  src/controllers/mpc/touchdown_tracker.cpp
  src/controllers/stand_hold_controller.cpp
)
target_include_directories(sidecar_protocol
  PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src"
  SYSTEM PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/third_party" "${EIGEN_ROOT_ABSOLUTE}"
)

add_executable(quadruped-simulation-sidecar
  src/main.cpp
)
target_link_libraries(sidecar_protocol PUBLIC mujoco_imported PRIVATE osqpstatic)
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
    SYSTEM PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/third_party" "${EIGEN_ROOT_ABSOLUTE}"
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

  add_executable(sidecar-mpc-tests tests/mpc_tests.cpp)
  target_link_libraries(sidecar-mpc-tests PRIVATE sidecar_protocol osqpstatic)
  target_include_directories(sidecar-mpc-tests
    SYSTEM PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/third_party" "${EIGEN_ROOT_ABSOLUTE}"
  )
  target_compile_definitions(sidecar-mpc-tests PRIVATE TEST_RESOURCE_ROOT="${CMAKE_SOURCE_DIR}/../../src-tauri")
  add_custom_command(TARGET sidecar-mpc-tests POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${MUJOCO_RUNTIME_LIBRARY}" "$<TARGET_FILE_DIR:sidecar-mpc-tests>"
  )
  if(MSVC)
    target_compile_options(sidecar-mpc-tests PRIVATE /W4 /WX /permissive- /EHsc /utf-8 /external:anglebrackets /external:W0)
  else()
    target_compile_options(sidecar-mpc-tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  endif()
  add_test(NAME sidecar-mpc-tests COMMAND sidecar-mpc-tests)

  add_executable(sidecar-mpc-integration-tests tests/mpc_integration_tests.cpp)
  target_link_libraries(sidecar-mpc-integration-tests PRIVATE sidecar_protocol)
  target_include_directories(sidecar-mpc-integration-tests
    SYSTEM PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/third_party" "${EIGEN_ROOT_ABSOLUTE}"
  )
  target_compile_definitions(sidecar-mpc-integration-tests PRIVATE TEST_RESOURCE_ROOT="${CMAKE_SOURCE_DIR}/../../src-tauri")
  add_custom_command(TARGET sidecar-mpc-integration-tests POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${MUJOCO_RUNTIME_LIBRARY}" "$<TARGET_FILE_DIR:sidecar-mpc-integration-tests>"
  )
  if(MSVC)
    target_compile_options(sidecar-mpc-integration-tests PRIVATE /W4 /WX /permissive- /EHsc /utf-8 /external:anglebrackets /external:W0)
  else()
    target_compile_options(sidecar-mpc-integration-tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  endif()
  add_test(NAME sidecar-mpc-integration-tests COMMAND sidecar-mpc-integration-tests)

  add_executable(sidecar-mpc-acceptance-tests tests/mpc_acceptance_tests.cpp)
  target_link_libraries(sidecar-mpc-acceptance-tests PRIVATE sidecar_protocol)
  target_include_directories(sidecar-mpc-acceptance-tests
    SYSTEM PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/third_party" "${EIGEN_ROOT_ABSOLUTE}"
  )
  target_compile_definitions(sidecar-mpc-acceptance-tests PRIVATE TEST_RESOURCE_ROOT="${CMAKE_SOURCE_DIR}/../../src-tauri")
  add_custom_command(TARGET sidecar-mpc-acceptance-tests POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${MUJOCO_RUNTIME_LIBRARY}" "$<TARGET_FILE_DIR:sidecar-mpc-acceptance-tests>"
  )
  if(MSVC)
    target_compile_options(sidecar-mpc-acceptance-tests PRIVATE /W4 /WX /permissive- /EHsc /utf-8 /external:anglebrackets /external:W0)
  else()
    target_compile_options(sidecar-mpc-acceptance-tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  endif()
  add_test(NAME sidecar-mpc-acceptance-tests COMMAND sidecar-mpc-acceptance-tests)
endif()
