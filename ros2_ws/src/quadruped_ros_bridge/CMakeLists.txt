cmake_minimum_required(VERSION 3.8)
project(quadruped_ros_bridge VERSION 0.1.0 LANGUAGES CXX)

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 17)
endif()
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(nav_msgs REQUIRED)
find_package(std_msgs REQUIRED)

find_path(NLOHMANN_JSON_INCLUDE_DIR nlohmann/json.hpp
  HINTS "${CMAKE_CURRENT_SOURCE_DIR}/../../../native/mujoco-sidecar/third_party"
  REQUIRED)

add_library(quadruped_ros_bridge_core
  src/protocol.cpp
  src/bridge_node.cpp)
target_include_directories(quadruped_ros_bridge_core
  PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>)
target_include_directories(quadruped_ros_bridge_core SYSTEM PUBLIC
  $<BUILD_INTERFACE:${NLOHMANN_JSON_INCLUDE_DIR}>)
ament_target_dependencies(quadruped_ros_bridge_core
  rclcpp geometry_msgs sensor_msgs nav_msgs std_msgs)

add_executable(quadruped_ros_bridge src/main.cpp)
target_link_libraries(quadruped_ros_bridge quadruped_ros_bridge_core)

foreach(target quadruped_ros_bridge_core quadruped_ros_bridge)
  target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror)
endforeach()

install(TARGETS quadruped_ros_bridge
  RUNTIME DESTINATION lib/${PROJECT_NAME})
install(DIRECTORY launch/ DESTINATION share/${PROJECT_NAME}/launch)

if(BUILD_TESTING)
  find_package(ament_cmake_gtest REQUIRED)
  ament_add_gtest(quadruped_ros_bridge_tests test/bridge_tests.cpp)
  target_link_libraries(quadruped_ros_bridge_tests quadruped_ros_bridge_core)
  target_include_directories(quadruped_ros_bridge_tests SYSTEM PRIVATE "${NLOHMANN_JSON_INCLUDE_DIR}")
  target_compile_options(quadruped_ros_bridge_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()

ament_package()
