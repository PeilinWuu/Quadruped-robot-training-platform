cmake_minimum_required(VERSION 3.6...3.31)

# get_filename_component(PROJECT_NAME ${CMAKE_CURRENT_SOURCE_DIR} NAME)
set(PROJECT_NAME "vk_gaussian_splatting")
Project(${PROJECT_NAME} LANGUAGES C CXX)

# Add the cmake folder to the module path
list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")
find_package(NvproCore2 REQUIRED)

# set with -DDISABLE_DEFAULT_SCENE=ON on command line or use cmake-gui to set the parameter
# if default scene is not disabled at build using this option, one can still disable it by 
# providing "-loadDefaultScene 0" to the sample command line
option(DISABLE_DEFAULT_SCENE "If set to true the default scene is not downloaded by CMake, and the sample does not try to open it when starting up with no scene as parameter" OFF)

# set with -DDISABLE_MESH_ASSETS_DOWNLOAD=ON on command line or use cmake-gui to set the parameter
option(DISABLE_MESH_ASSETS_DOWNLOAD "If set to true the test mesh assets are not downloaded by CMake" OFF)

#####################################################################################
# additions of 3rdparty

#####
# Include Vulkan Radix Sort
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/3rdparty/vrdx)

set_property(TARGET vk_radix_sort PROPERTY FOLDER "ThirdParty/vrdx")
set_property(TARGET spine_slang PROPERTY FOLDER "ThirdParty/vrdx")
set_property(TARGET downsweep_slang PROPERTY FOLDER "ThirdParty/vrdx")
set_property(TARGET downsweep_key_value_slang PROPERTY FOLDER "ThirdParty/vrdx")
set_property(TARGET upsweep_slang PROPERTY FOLDER "ThirdParty/vrdx")

#####
# Include spz (uses zlib from nvpro_core2)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/3rdparty/spz)
set_property(TARGET spz PROPERTY FOLDER "ThirdParty")

#####################################################################################
# Source files for this project
#
# New files under src/ require CMake reconfigure in VS (Delete Cache and Reconfigure if rebuild fails).
file(GLOB SOURCE_FILES src/*.*)
file(GLOB SHADER_FILES shaders/*.slang shaders/*.h)
file(GLOB EXTERN_FILES 3rdparty/miniply/*.*)

include_directories(
  ${CMAKE_CURRENT_SOURCE_DIR}/src 
  ${CMAKE_CURRENT_SOURCE_DIR}/shaders 
  ${CMAKE_CURRENT_SOURCE_DIR}/3rdparty/miniply
  ${CMAKE_CURRENT_SOURCE_DIR}/3rdparty/vrdx
  ${CMAKE_CURRENT_SOURCE_DIR}/3rdparty/spz/src/cc)

#####################################################################################
# Executable
#

add_executable(${PROJECT_NAME} ${SOURCE_FILES} ${COMMON_SOURCE_FILES} ${PACKAGE_SOURCE_FILES} ${SHADER_FILES} ${EXTERN_FILES})

set_property(DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR} PROPERTY VS_STARTUP_PROJECT ${PROJECT_NAME})

target_compile_definitions(${PROJECT_NAME} PRIVATE IMGUI_DEFINE_MATH_OPERATORS )

#####################################################################################
# common source code needed for this sample
#
source_group(common FILES 
  ${COMMON_SOURCE_FILES}
  ${PACKAGE_SOURCE_FILES}
)
source_group("Shader Files" FILES ${SHADER_FILES})
source_group("Source Files" FILES ${SOURCE_FILES})
source_group("Extern Files" FILES ${EXTERN_FILES})

#####################################################################################
# Linkage
#

# Linking with other libraries
# Link libraries and include directories
target_link_libraries(${PROJECT_NAME} PRIVATE
  nvpro2::nvapp
  nvpro2::nvgui
  nvpro2::nvvkglsl
  nvpro2::nvslang
  nvpro2::nvshaders_host
  nvpro2::nvutils
  nvpro2::nvvk
  nvpro2::nvgpu_monitor
  vk_radix_sort
  spz::spz
)

add_project_definitions(${PROJECT_NAME})

#####################################################################################
# copies files
#

copy_to_runtime_and_install(${PROJECT_NAME}
  DIRECTORIES "${NVSHADERS_DIR}/nvshaders"
  FILES ${Slang_GLSLANG}
  LOCAL_DIRS "${CMAKE_CURRENT_LIST_DIR}/shaders"
  AUTO
)