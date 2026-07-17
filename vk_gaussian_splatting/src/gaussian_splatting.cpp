/*
 * Copyright (c) 2023-2025, NVIDIA CORPORATION.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-FileCopyrightText: Copyright (c) 2023-2025, NVIDIA CORPORATION.
 * SPDX-License-Identifier: Apache-2.0
 */

// Vulkan Memory Allocator
#define VMA_IMPLEMENTATION
#define VMA_LEAK_LOG_FORMAT(format, ...)                                                                               \
  {                                                                                                                    \
    printf((format), __VA_ARGS__);                                                                                     \
    printf("\n");                                                                                                      \
  }

#include "gaussian_splatting.h"
#include "utilities.h"

#define STBIW_WINDOWS_UTF8
#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STB_IMAGE_WRITE_STATIC
#include <stb/stb_image_write.h>

#define GLM_ENABLE_SWIZZLE
#include <glm/gtc/packing.hpp>  // Required for half-float operations

#include <algorithm>
#include <cmath>
#include <cstring>
#include <cstdint>
#include <limits>
#include <chrono>
#include <fstream>
#include <sstream>
#include <iomanip>

#include <tinygltf/json.hpp>
#include <nvvk/check_error.hpp>
#include <nvvk/descriptors.hpp>
#include <nvvk/graphics_pipeline.hpp>
#include <nvvk/sbt_generator.hpp>
#include <nvvk/formats.hpp>

namespace vk_gaussian_splatting {

namespace {

VkDeviceSize depthBytesPerPixel(VkFormat format)
{
  switch(format)
  {
    case VK_FORMAT_D16_UNORM: return 2;
    case VK_FORMAT_D16_UNORM_S8_UINT: return 2;  // depth aspect only
    case VK_FORMAT_D24_UNORM_S8_UINT: return 4;  // packed
    case VK_FORMAT_X8_D24_UNORM_PACK32: return 4;
    case VK_FORMAT_D32_SFLOAT: return 4;
    case VK_FORMAT_D32_SFLOAT_S8_UINT: return 4;  // depth aspect only
    default: return 4;
  }
}

float decodeDepthValue(const uint8_t* ptr, VkFormat format)
{
  switch(format)
  {
    case VK_FORMAT_D16_UNORM: {
      uint16_t raw{};
      std::memcpy(&raw, ptr, sizeof(raw));
      return float(raw) / 65535.0F;
    }
    case VK_FORMAT_D16_UNORM_S8_UINT: {
      uint16_t raw{};
      std::memcpy(&raw, ptr, sizeof(raw));
      return float(raw) / 65535.0F;
    }
    case VK_FORMAT_D24_UNORM_S8_UINT:
    case VK_FORMAT_X8_D24_UNORM_PACK32: {
      uint32_t raw{};
      std::memcpy(&raw, ptr, sizeof(raw));
      const uint32_t depth24 = raw & 0x00FFFFFFU;
      return float(depth24) / 16777215.0F;
    }
    case VK_FORMAT_D32_SFLOAT:
    case VK_FORMAT_D32_SFLOAT_S8_UINT: {
      float raw{};
      std::memcpy(&raw, ptr, sizeof(raw));
      return raw;
    }
    default: {
      float raw{};
      std::memcpy(&raw, ptr, sizeof(raw));
      return raw;
    }
  }
}

}  // namespace

GaussianSplatting::GaussianSplatting(nvutils::ProfilerManager* profilerManager, nvutils::ParameterRegistry* parameterRegistry)
    : m_profilerManager(profilerManager)
    , m_parameterRegistry(parameterRegistry)
    , cameraManip(std::make_shared<nvutils::CameraManipulator>()) {

    };

GaussianSplatting::~GaussianSplatting(){
    // all threads must be stopped,
    // work done in onDetach(),
    // could be done here, same result
};

void GaussianSplatting::onAttach(nvapp::Application* app)
{
  // shortcuts
  m_app    = app;
  m_device = m_app->getDevice();

  // profiling
  m_profilerTimeline = m_profilerManager->createTimeline({.name = "Primary Timeline"});
  m_profilerGpuTimer.init(m_profilerTimeline, m_app->getDevice(), m_app->getPhysicalDevice(), m_app->getQueue(0).familyIndex, false);

  // starts the asynchronous services
  m_plyLoader.initialize();
  m_cpuSorter.initialize(m_profilerTimeline);

  // Memory allocator
  m_alloc.init(VmaAllocatorCreateInfo{
      .flags            = VMA_ALLOCATOR_CREATE_BUFFER_DEVICE_ADDRESS_BIT,
      .physicalDevice   = app->getPhysicalDevice(),
      .device           = app->getDevice(),
      .instance         = app->getInstance(),
      .vulkanApiVersion = VK_API_VERSION_1_4,
  });

  // DEBUG: uncomment and set id to find object leak
  // m_alloc.setLeakID(70);

  // set up buffer uploading utility
  m_uploader.init(&m_alloc, true);

  // Acquiring the sampler which will be used for displaying the GBuffer and accessing textures
  m_samplerPool.init(app->getDevice());
  NVVK_CHECK(m_samplerPool.acquireSampler(m_sampler));
  NVVK_DBG_NAME(m_sampler);

  // GBuffer
  m_depthFormat = nvvk::findDepthFormat(app->getPhysicalDevice());

  // Two GBuffer color attachments, the second one is used only when temporal sampling with 3DGUT
  m_gBuffers.init({
      .allocator      = &m_alloc,
      .colorFormats   = {m_colorFormat, m_colorFormat, VK_FORMAT_R32_UINT},
      .depthFormat    = m_depthFormat,
      .imageSampler   = m_sampler,
      .descriptorPool = m_app->getTextureDescriptorPool(),
  });

  // Setting up the Slang compiler
  {
    // Where to find shaders source code
    m_slangCompiler.addSearchPaths(getShaderDirs());
    // SPIRV 1.6 and VULKAN 1.4
    m_slangCompiler.defaultTarget();
    m_slangCompiler.defaultOptions();
    m_slangCompiler.addOption({slang::CompilerOptionName::MatrixLayoutRow, {slang::CompilerOptionValueKind::Int, 1}});
    m_slangCompiler.addOption({slang::CompilerOptionName::DebugInformation,
                               {slang::CompilerOptionValueKind::Int, SLANG_DEBUG_INFO_LEVEL_MAXIMAL}});
    m_slangCompiler.addOption({slang::CompilerOptionName::Optimization,
                               {slang::CompilerOptionValueKind::Int, SLANG_OPTIMIZATION_LEVEL_DEFAULT}});
  }

  // Get device information
  m_physicalDeviceInfo.init(m_app->getPhysicalDevice(), VK_API_VERSION_1_4);

  // Get ray tracing properties
  m_rtProperties.pNext = &m_accelStructProps;
  VkPhysicalDeviceProperties2 prop2{.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2, .pNext = &m_rtProperties};
  vkGetPhysicalDeviceProperties2(m_app->getPhysicalDevice(), &prop2);

  // init the Vulkan splatSet and the mesh set for mesh compositing
  m_splatSetVk.init(m_app, &m_alloc, &m_uploader, &m_sampler, &m_physicalDeviceInfo, &m_accelStructProps);
  m_meshSetVk.init(m_app, &m_alloc, &m_uploader, &m_accelStructProps);
  m_cameraSet.init(cameraManip.get());
};

void GaussianSplatting::onDetach()
{
  // stops the threads
  m_plyLoader.shutdown();
  m_cpuSorter.shutdown();
  // release scene and rendering related resources
  deinitAll();
  // release application wide related resources
  m_splatSetVk.deinit();
  m_meshSetVk.deinit();
  m_profilerGpuTimer.deinit();
  m_profilerManager->destroyTimeline(m_profilerTimeline);
  m_profilerTimeline = nullptr;
  m_gBuffers.deinit();
  m_samplerPool.releaseSampler(m_sampler);
  m_samplerPool.deinit();
  m_uploader.deinit();
  m_alloc.deinit();
}

void GaussianSplatting::onResize(VkCommandBuffer cmd, const VkExtent2D& viewportSize)
{
  m_viewSize = {viewportSize.width, viewportSize.height};
  NVVK_CHECK(m_gBuffers.update(cmd, viewportSize));
  updateRtDescriptorSet();
  updateDescriptorSetPostProcessing();
  resetFrameCounter();
}

void GaussianSplatting::onPreRender()
{
  m_profilerTimeline->frameAdvance();
}

void GaussianSplatting::onRender(VkCommandBuffer cmd)
{
  NVVK_DBG_SCOPE(cmd);

  // update buffers, rebuild shaders and pipelines if needed
  processUpdateRequests();
  collectDepthReadBackIfNeeded();
  collectSegReadBackIfNeeded();
  collectRgbReadBackIfNeeded();
  tickMultiViewExport();

  // 0 if not ready so the rendering does not
  // touch the splat set while loading
  // getStatus is thread safe.
  uint32_t splatCount = 0;
  if(m_plyLoader.getStatus() == PlyLoaderAsync::State::E_READY)
  {
    splatCount = (uint32_t)m_splatSet.size();
  }

  //////////////////
  // Full raytrace pipeline

  if(m_shaders.valid && splatCount && prmSelectedPipeline == PIPELINE_RTX)
  {
    if(!m_splatSetVk.rtxValid)
    {
      // let's switch back to raster, RTX is KO
      prmSelectedPipeline = PIPELINE_MESH;
      return;
    }

    if(prmRtx.temporalSampling && !updateFrameCounter())
      return;

    collectReadBackValuesIfNeeded();

    updateAndUploadFrameInfoUBO(cmd, splatCount);

    clearSegBuffer(cmd);
    raytrace(cmd);

    readBackIndirectParametersIfNeeded(cmd);

    updateRenderingMemoryStatistics(cmd, splatCount);
    readBackDepthIfRequested(cmd);
    readBackSegIfRequested(cmd);
    readBackRgbIfRequested(cmd);

    // Attention: early return
    return;
  }

  ///////////////////
  // From this point we are using full raster or hybrid.

  if(prmRtx.temporalSampling && !updateFrameCounter())
    return;

  // Handle device-host data update and splat sorting if a scene exist
  if(m_shaders.valid && splatCount)
  {
    // collect readback results from previous frame if any
    collectReadBackValuesIfNeeded();

    //
    updateAndUploadFrameInfoUBO(cmd, splatCount);

    if(prmRaster.sortingMethod == SORTING_GPU_SYNC_RADIX)
    {
      // remove eventual async CPU sorting timers
      // so that it will not appear since not sorting on CPU anymore
      m_profilerTimeline->asyncRemoveTimer("CPU Dist");
      m_profilerTimeline->asyncRemoveTimer("CPU Sort");
      // now work on GPU
      processSortingOnGPU(cmd, splatCount);
    }
    else
    {
      tryConsumeAndUploadCpuSortingResult(cmd, splatCount);
    }
  }

  // In which color buffer are we going to render ?
  uint32_t colorBufferId = COLOR_MAIN;
  if(prmRtx.temporalSampling && prmFrame.frameSampleId > 0)
    colorBufferId = COLOR_AUX1;

  // raytrace the mesh depth using primary rays if needed
  bool raytraceMeshDepth = m_shaders.valid && !m_meshSetVk.instances.empty() && prmSelectedPipeline == PIPELINE_HYBRID_3DGUT;

  nvvk::cmdImageMemoryBarrier(cmd, {m_gBuffers.getDepthImage(),
                                    VK_IMAGE_LAYOUT_UNDEFINED,  // or previous
                                    VK_IMAGE_LAYOUT_GENERAL,    // for ray tracing writes
                                    {VK_IMAGE_ASPECT_DEPTH_BIT, 0, VK_REMAINING_MIP_LEVELS, 0, VK_REMAINING_ARRAY_LAYERS}});

  if(raytraceMeshDepth)
  {
    clearSegBuffer(cmd);
    raytrace(cmd, true);
  }

  // Drawing the primitives in the G-Buffer
  {
    auto timerSection = m_profilerGpuTimer.cmdFrameSection(cmd, "Rasterization");

    const VkExtent2D& viewportSize = m_app->getViewportSize();
    const VkViewport  viewport{0.0F, 0.0F, float(viewportSize.width), float(viewportSize.height), 0.0F, 1.0F};
    const VkRect2D    scissor{{0, 0}, viewportSize};

    VkRenderingAttachmentInfo colorAttachment = DEFAULT_VkRenderingAttachmentInfo;
    colorAttachment.imageView                 = m_gBuffers.getColorImageView(colorBufferId);
    colorAttachment.clearValue                = {m_clearColor};
    VkRenderingAttachmentInfo segAttachment   = DEFAULT_VkRenderingAttachmentInfo;
    segAttachment.imageView                   = m_gBuffers.getColorImageView(COLOR_SEG);
    segAttachment.clearValue                  = {{0.0F, 0.0F, 0.0F, 0.0F}};
    VkRenderingAttachmentInfo depthAttachment = DEFAULT_VkRenderingAttachmentInfo;
    if(raytraceMeshDepth)
    {
      depthAttachment.loadOp = VK_ATTACHMENT_LOAD_OP_LOAD;  // <-- preserve existing depth
    }
    depthAttachment.imageView  = m_gBuffers.getDepthImageView();
    depthAttachment.clearValue = {.depthStencil = DEFAULT_VkClearDepthStencilValue};

    // Create the rendering info
    VkRenderingInfo renderingInfo      = DEFAULT_VkRenderingInfo;
    renderingInfo.renderArea           = DEFAULT_VkRect2D(m_gBuffers.getSize());
    VkRenderingAttachmentInfo colorAttachments[2] = {colorAttachment, segAttachment};
    renderingInfo.colorAttachmentCount = 2;
    renderingInfo.pColorAttachments    = colorAttachments;
    renderingInfo.pDepthAttachment     = &depthAttachment;

    nvvk::cmdImageMemoryBarrier(cmd, {m_gBuffers.getColorImage(colorBufferId), VK_IMAGE_LAYOUT_GENERAL,
                                      VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL});
    nvvk::cmdImageMemoryBarrier(cmd, {m_gBuffers.getColorImage(COLOR_SEG), VK_IMAGE_LAYOUT_GENERAL,
                                      VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL});

    nvvk::cmdImageMemoryBarrier(cmd, {m_gBuffers.getDepthImage(),
                                      VK_IMAGE_LAYOUT_GENERAL,
                                      VK_IMAGE_LAYOUT_DEPTH_ATTACHMENT_OPTIMAL,
                                      {VK_IMAGE_ASPECT_DEPTH_BIT, 0, VK_REMAINING_MIP_LEVELS, 0, VK_REMAINING_ARRAY_LAYERS}});

    vkCmdBeginRendering(cmd, &renderingInfo);

    vkCmdSetViewportWithCount(cmd, 1, &viewport);
    vkCmdSetScissorWithCount(cmd, 1, &scissor);

    // mesh first so that occluded splats fragments will be discarded by depth test
    if(m_shaders.valid && !m_meshSetVk.instances.empty() && !raytraceMeshDepth)
    {
      drawMeshPrimitives(cmd);
    }

    // splat set
    if(m_shaders.valid && splatCount)
    {

      drawSplatPrimitives(cmd, splatCount);
    }

    vkCmdEndRendering(cmd);

    nvvk::cmdImageMemoryBarrier(cmd, {m_gBuffers.getColorImage(colorBufferId), VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
                                      VK_IMAGE_LAYOUT_GENERAL});
    nvvk::cmdImageMemoryBarrier(cmd, {m_gBuffers.getColorImage(COLOR_SEG), VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
                                      VK_IMAGE_LAYOUT_GENERAL});
    nvvk::cmdImageMemoryBarrier(cmd, {m_gBuffers.getDepthImage(),
                                      VK_IMAGE_LAYOUT_DEPTH_ATTACHMENT_OPTIMAL,
                                      VK_IMAGE_LAYOUT_GENERAL,
                                      {VK_IMAGE_ASPECT_DEPTH_BIT, 0, VK_REMAINING_MIP_LEVELS, 0, VK_REMAINING_ARRAY_LAYERS}});
  }

  // raytrace the secondary rays if needed
  if(m_shaders.valid && splatCount && m_splatSetVk.rtxValid && !m_meshSetVk.instances.empty()
     && (prmSelectedPipeline == PIPELINE_HYBRID || prmSelectedPipeline == PIPELINE_HYBRID_3DGUT))
  {
    raytrace(cmd);
  }

  // Perform post processings if needed
  if(prmRtx.temporalSampling && prmFrame.frameSampleId > 0)
  {
    postProcess(cmd);
  }

  //
  readBackIndirectParametersIfNeeded(cmd);

  updateRenderingMemoryStatistics(cmd, splatCount);
  readBackDepthIfRequested(cmd);
  readBackSegIfRequested(cmd);
  readBackRgbIfRequested(cmd);
}

void GaussianSplatting::processUpdateRequests(void)
{

  // Automatic and Sanity settings depending in pipeline
  if(prmSelectedPipeline != PIPELINE_RTX && prmSelectedPipeline != PIPELINE_HYBRID_3DGUT && prmSelectedPipeline != PIPELINE_MESH_3DGUT)
  {
    prmRtx.temporalSampling = false;
    // prmRtx.dofEnabled       = false;
  }
  else
  {
    if(prmRtx.temporalSamplingMode == TEMPORAL_SAMPLING_AUTO && m_cameraSet.getCamera().dofEnabled)
    {
      prmRtx.temporalSampling = true;
    }
    else
    {
      prmRtx.temporalSampling = (prmRtx.temporalSamplingMode == TEMPORAL_SAMPLING_ENABLED);
    }
  }

  // process delayed requests
  if((prmSelectedPipeline == PIPELINE_RTX || prmSelectedPipeline == PIPELINE_HYBRID || prmSelectedPipeline == PIPELINE_HYBRID_3DGUT)
     && m_requestDelayedUpdateSplatAs)
  {
    m_requestUpdateSplatAs        = true;
    m_requestDelayedUpdateSplatAs = false;
  }

  bool needUpdate = m_requestUpdateSplatData || m_requestUpdateSplatAs || m_requestUpdateMeshData
                    || m_requestUpdateShaders || m_requestUpdateLightsBuffer || m_requestDeleteSelectedMesh;

  if(!m_splatSet.size() || !needUpdate)
    return;

  resetFrameCounter();

  vkDeviceWaitIdle(m_device);

  // updates that requires update of descriptor sets
  if(m_requestUpdateSplatData || m_requestUpdateSplatAs || m_requestUpdateMeshData || m_requestUpdateShaders || m_requestDeleteSelectedMesh)
  {

    deinitPipelines();
    deinitShaders();

    if(m_requestUpdateSplatData)
    {
      m_splatSetVk.deinitDataStorage();
      m_splatSetVk.initDataStorage(m_splatSet, prmData.dataStorage, prmData.shFormat);
    }
    if(m_requestUpdateSplatData || m_requestUpdateSplatAs)
    {
      // RTX specific
      m_splatSetVk.rtxDeinitAccelerationStructures();
      m_splatSetVk.rtxDeinitSplatModel();
      m_splatSetVk.rtxInitSplatModel(m_splatSet, prmRtxData.useTlasInstances, prmRtxData.useAABBs, prmRtxData.compressBlas,
                                     prmRtx.kernelDegree, prmRtx.kernelMinResponse, prmRtx.kernelAdaptiveClamping);
      m_splatSetVk.rtxInitAccelerationStructures(m_splatSet);
    }

    if(m_requestUpdateMeshData || m_requestDeleteSelectedMesh)
    {
      if(m_requestDeleteSelectedMesh)
      {
        m_meshSetVk.deleteInstance(uint32_t(m_selectedItemIndex));
        m_selectedItemIndex = -1;
      }

      m_meshSetVk.rtxDeinitAccelerationStructures();
      m_meshSetVk.updateObjDescriptionBuffer();
      m_meshSetVk.rtxInitAccelerationStructures();
    }

    if(initShaders())
    {
      initPipelines();
      initRtDescriptorSet();
      initRtPipeline();
      initDescriptorSetPostProcessing();
      initPipelinePostProcessing();
    }
  }

  // light buffer is never reallocated
  // updates does not require description set changes
  if(m_requestUpdateLightsBuffer)
  {
    m_lightSet.updateBuffer();
    m_requestUpdateLightsBuffer = false;
  }

  // reset request
  m_requestUpdateSplatData = m_requestUpdateSplatAs = m_requestUpdateMeshData = m_requestUpdateShaders =
      m_requestUpdateLightsBuffer = m_requestDeleteSelectedMesh = false;
}


void GaussianSplatting::updateAndUploadFrameInfoUBO(VkCommandBuffer cmd, const uint32_t splatCount)
{
  NVVK_DBG_SCOPE(cmd);

  auto timerSection = m_profilerGpuTimer.cmdFrameSection(cmd, "UBO update");

  Camera camera = m_cameraSet.getCamera();

  cameraManip->getLookat(m_eye, m_center, m_up);

  // Update frame parameters uniform buffer
  // some attributes of prmFrame were directly set by the user interface
  prmFrame.splatCount = splatCount;
  prmFrame.lightCount = int32_t(m_lightSet.size());

  prmFrame.cameraPosition = m_eye;
  prmFrame.viewMatrix     = cameraManip->getViewMatrix();
  prmFrame.viewInverse    = glm::inverse(prmFrame.viewMatrix);

  prmFrame.fovRad  = cameraManip->getRadFov();
  prmFrame.nearFar = cameraManip->getClipPlanes();
  // Projection matrix only viable in pinhole mode,
  // but is used as a fallback for 3DGS when Fisheye is on
  prmFrame.projectionMatrix = cameraManip->getPerspectiveMatrix();
  prmFrame.projInverse      = glm::inverse(prmFrame.projectionMatrix);

  float       devicePixelRatio     = 1.0;
  const bool  isOrthographicCamera = false;
  const float focalMultiplier      = isOrthographicCamera ? (1.0f / devicePixelRatio) : 1.0f;
  const float focalAdjustment      = focalMultiplier;
  prmFrame.orthoZoom               = 1.0f;
  prmFrame.orthographicMode        = 0;  // disabled (uses perspective) TODO: activate support for orthographic
  prmFrame.viewport                = glm::vec2(m_viewSize.x * devicePixelRatio, m_viewSize.y * devicePixelRatio);
  prmFrame.basisViewport           = glm::vec2(1.0f / m_viewSize.x, 1.0f / m_viewSize.y);
  prmFrame.inverseFocalAdjustment  = 1.0f / focalAdjustment;

  if(camera.model == CAMERA_FISHEYE && prmSelectedPipeline != PIPELINE_VERT && prmSelectedPipeline != PIPELINE_MESH
     && prmSelectedPipeline != PIPELINE_HYBRID)
  {
    // FISHEYE focal
    prmFrame.focal = glm::vec2(1.0, -1.0) * prmFrame.viewport / prmFrame.fovRad;
  }
  else
  {
    // PIHNOLE focal
    const float focalLengthX = prmFrame.projectionMatrix[0][0] * 0.5f * devicePixelRatio * m_viewSize.x;
    const float focalLengthY = prmFrame.projectionMatrix[1][1] * 0.5f * devicePixelRatio * m_viewSize.y;
    prmFrame.focal           = glm::vec2(focalLengthX, focalLengthY);
  }

  // Camera pose, used by unscented transform
  {
    prmFrame.viewTrans = prmFrame.viewMatrix[3];
    glm::quat viewQuat = glm::quat_cast(prmFrame.viewMatrix);
    // glm quaternion storage is scalar last, so we forward as is
    prmFrame.viewQuat = glm::vec4(viewQuat.x, viewQuat.y, viewQuat.z, viewQuat.w);
  }

  prmFrame.focusDist = camera.focusDist;
  prmFrame.aperture  = camera.aperture;

  // the buffer is small so we use vkCmdUpdateBuffer for the transfer
  vkCmdUpdateBuffer(cmd, m_frameInfoBuffer.buffer, 0, sizeof(shaderio::FrameInfo), &prmFrame);

  // sync with end of copy to device
  VkMemoryBarrier barrier = {VK_STRUCTURE_TYPE_MEMORY_BARRIER};
  barrier.srcAccessMask   = VK_ACCESS_TRANSFER_WRITE_BIT;
  barrier.dstAccessMask   = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_UNIFORM_READ_BIT;

  vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_2_TRANSFER_BIT,
                       VK_PIPELINE_STAGE_2_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_2_VERTEX_SHADER_BIT
                           | VK_PIPELINE_STAGE_2_FRAGMENT_SHADER_BIT | VK_PIPELINE_STAGE_2_MESH_SHADER_BIT_EXT,
                       0, 1, &barrier, 0, NULL, 0, NULL);
}

void GaussianSplatting::tryConsumeAndUploadCpuSortingResult(VkCommandBuffer cmd, const uint32_t splatCount)
{
  NVVK_DBG_SCOPE(cmd);

  // upload CPU sorted indices to the GPU if needed
  bool newIndexAvailable = false;

  if(!prmRender.opacityGaussianDisabled)
  {
    // 1. Splatting/blending is on, we check for a newly sorted index table
    auto status = m_cpuSorter.getStatus();
    if(status != SplatSorterAsync::E_SORTING)
    {
      // sorter is sleeping, we can work on shared data
      // we take into account the result of the sort
      if(status == SplatSorterAsync::E_SORTED)
      {
        m_cpuSorter.consume(m_splatIndices);
        newIndexAvailable = true;
      }

      // let's wakeup the sorting thread to run a new sort if needed
      // will start work only if camera direction or position has changed
      m_cpuSorter.sortAsync(glm::normalize(m_center - m_eye), m_eye, m_splatSet.positions, m_splatSetVk.transform,
                            prmRaster.cpuLazySort);
    }
  }
  else
  {
    // splatting off, we disable the sorting
    // indices would not be needed for non splatted points
    // however, using the same mechanism allows to use exactly the same shader
    // so if splatting/blending is off we provide an ordered table of indices
    // if not already filled by any other previous frames (sorted or not)
    bool refill = (m_splatIndices.size() != splatCount);
    if(refill)
    {
      m_splatIndices.resize(splatCount);
      for(uint32_t i = 0; i < splatCount; ++i)
      {
        m_splatIndices[i] = i;
      }
      newIndexAvailable = true;
    }
  }

  // 2. upload to GPU is needed
  {
    auto timerSection = m_profilerGpuTimer.cmdFrameSection(cmd, "Copy indices to GPU");

    if(newIndexAvailable)
    {
      // Prepare buffer on host using sorted indices
      memcpy(m_splatIndicesHost.mapping, m_splatIndices.data(), m_splatIndices.size() * sizeof(uint32_t));
      // copy buffer to device
      VkBufferCopy bc{.srcOffset = 0, .dstOffset = 0, .size = splatCount * sizeof(uint32_t)};
      vkCmdCopyBuffer(cmd, m_splatIndicesHost.buffer, m_splatIndicesDevice.buffer, 1, &bc);
      // sync with end of copy to device
      VkMemoryBarrier barrier = {VK_STRUCTURE_TYPE_MEMORY_BARRIER};
      barrier.srcAccessMask   = VK_ACCESS_TRANSFER_WRITE_BIT;
      barrier.dstAccessMask   = VK_ACCESS_SHADER_READ_BIT;

      vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_2_TRANSFER_BIT,
                           VK_PIPELINE_STAGE_2_VERTEX_SHADER_BIT | VK_PIPELINE_STAGE_2_FRAGMENT_SHADER_BIT | VK_PIPELINE_STAGE_2_MESH_SHADER_BIT_EXT,
                           0, 1, &barrier, 0, NULL, 0, NULL);
    }
  }
}

void GaussianSplatting::processSortingOnGPU(VkCommandBuffer cmd, const uint32_t splatCount)
{
  NVVK_DBG_SCOPE(cmd);

  // when GPU sorting, we sort at each frame, all buffer in device memory, no copy from RAM

  // 1. reset the draw indirect parameters and counters, will be updated by compute shader
  {
    const shaderio::IndirectParams drawIndexedIndirectParams;
    vkCmdUpdateBuffer(cmd, m_indirect.buffer, 0, sizeof(shaderio::IndirectParams), (void*)&drawIndexedIndirectParams);

    VkMemoryBarrier barrier = {VK_STRUCTURE_TYPE_MEMORY_BARRIER};
    barrier.srcAccessMask   = VK_ACCESS_TRANSFER_WRITE_BIT;
    barrier.dstAccessMask   = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_INDIRECT_COMMAND_READ_BIT;

    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_2_TRANSFER_BIT,
                         VK_PIPELINE_STAGE_2_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_2_MESH_SHADER_BIT_EXT | VK_PIPELINE_STAGE_2_DRAW_INDIRECT_BIT,
                         0, 1, &barrier, 0, NULL, 0, NULL);
  }

  VkMemoryBarrier barrier = {VK_STRUCTURE_TYPE_MEMORY_BARRIER};
  barrier.srcAccessMask   = VK_ACCESS_SHADER_WRITE_BIT;
  barrier.dstAccessMask   = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_INDIRECT_COMMAND_READ_BIT;

  // 2. invoke the distance compute shader
  {
    auto timerSection = m_profilerGpuTimer.cmdFrameSection(cmd, "GPU Dist");

    vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, m_computePipelineGsDistCull);
    vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, m_pipelineLayout, 0, 1, &m_descriptorSet, 0, nullptr);

    // Model transform
    m_pcRaster.modelMatrix        = m_splatSetVk.transform;
    m_pcRaster.modelMatrixInverse = m_splatSetVk.transformInverse;

    vkCmdPushConstants(cmd, m_pipelineLayout,
                       VK_SHADER_STAGE_COMPUTE_BIT | VK_SHADER_STAGE_MESH_BIT_EXT | VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT,
                       0, sizeof(shaderio::PushConstant), &m_pcRaster);

    vkCmdDispatch(cmd, (splatCount + prmRaster.distShaderWorkgroupSize - 1) / prmRaster.distShaderWorkgroupSize, 1, 1);

    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_2_COMPUTE_SHADER_BIT,
                         VK_PIPELINE_STAGE_2_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_2_MESH_SHADER_BIT_EXT | VK_PIPELINE_STAGE_2_DRAW_INDIRECT_BIT,
                         0, 1, &barrier, 0, NULL, 0, NULL);
  }

  // 3. invoke the radix sort from vrdx lib
  {
    auto timerSection = m_profilerGpuTimer.cmdFrameSection(cmd, "GPU Sort");

    vrdxCmdSortKeyValueIndirect(cmd, m_gpuSorter, splatCount, m_indirect.buffer,
                                offsetof(shaderio::IndirectParams, instanceCount), m_splatDistancesDevice.buffer, 0,
                                m_splatIndicesDevice.buffer, 0, m_vrdxStorageDevice.buffer, 0, 0, 0);

    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_2_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_2_TRANSFER_BIT,
                         VK_PIPELINE_STAGE_2_VERTEX_SHADER_BIT | VK_PIPELINE_STAGE_2_MESH_SHADER_BIT_EXT | VK_PIPELINE_STAGE_2_DRAW_INDIRECT_BIT,
                         0, 1, &barrier, 0, NULL, 0, NULL);
  }
}

void GaussianSplatting::drawSplatPrimitives(VkCommandBuffer cmd, const uint32_t splatCount)
{
  NVVK_DBG_SCOPE(cmd);

  // Do we need to activate depth test and Write ?
  bool needDepth = ((prmRaster.sortingMethod != SORTING_GPU_SYNC_RADIX) && prmRender.opacityGaussianDisabled)
                   || !m_meshSetVk.instances.empty() || m_requestDepthExportPng || m_requestSegExportPng
                   || m_requestRgbExportPng || m_multiViewExport.active;

  // Model transform
  m_pcRaster.modelMatrix        = m_splatSetVk.transform;
  m_pcRaster.modelMatrixInverse = m_splatSetVk.transformInverse;
  // cast to mat3 extracts only the rot/scale part of the transform
  glm::mat3 rotScale                    = glm::mat3(m_splatSetVk.transform);
  m_pcRaster.modelMatrixRotScaleInverse = glm::inverse(rotScale);

  vkCmdPushConstants(cmd, m_pipelineLayout,
                     VK_SHADER_STAGE_COMPUTE_BIT | VK_SHADER_STAGE_MESH_BIT_EXT | VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT,
                     0, sizeof(shaderio::PushConstant), &m_pcRaster);

  if(prmSelectedPipeline == PIPELINE_VERT)
  {  // Pipeline using vertex shader
    vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, m_graphicsPipelineGsVert);
    vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, m_pipelineLayout, 0, 1, &m_descriptorSet, 0, nullptr);

    // overrides the pipeline setup for depth test/write
    vkCmdSetDepthWriteEnable(cmd, (VkBool32)needDepth);
    vkCmdSetDepthTestEnable(cmd, (VkBool32)needDepth);

    // display the quad as many times as we have visible splats
    const VkDeviceSize offsets{0};
    vkCmdBindIndexBuffer(cmd, m_quadIndices.buffer, 0, VK_INDEX_TYPE_UINT16);
    vkCmdBindVertexBuffers(cmd, 0, 1, &m_quadVertices.buffer, &offsets);
    if(prmRaster.sortingMethod != SORTING_GPU_SYNC_RADIX)
    {
      vkCmdBindVertexBuffers(cmd, 1, 1, &m_splatIndicesDevice.buffer, &offsets);
      vkCmdDrawIndexed(cmd, 6, (uint32_t)splatCount, 0, 0, 0);
    }
    else
    {
      vkCmdBindVertexBuffers(cmd, 1, 1, &m_splatIndicesDevice.buffer, &offsets);
      vkCmdDrawIndexedIndirect(cmd, m_indirect.buffer, 0, 1, sizeof(VkDrawIndexedIndirectCommand));
    }
  }
  else
  {  // in mesh pipeline mode or in hybrid mode
    // Pipeline using mesh shader

    if(prmSelectedPipeline == PIPELINE_MESH || prmSelectedPipeline == PIPELINE_HYBRID)
      vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, m_graphicsPipelineGsMesh);
    if(prmSelectedPipeline == PIPELINE_MESH_3DGUT || prmSelectedPipeline == PIPELINE_HYBRID_3DGUT)
      vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, m_graphicsPipeline3dgutMesh);

    vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, m_pipelineLayout, 0, 1, &m_descriptorSet, 0, nullptr);

    // overrides the pipeline setup for depth test/write
    vkCmdSetDepthWriteEnable(cmd, (VkBool32)needDepth);
    vkCmdSetDepthTestEnable(cmd, (VkBool32)needDepth);

    if(prmRaster.sortingMethod != SORTING_GPU_SYNC_RADIX)
    {
      // run the workgroups
      vkCmdDrawMeshTasksEXT(cmd, (prmFrame.splatCount + prmRaster.meshShaderWorkgroupSize - 1) / prmRaster.meshShaderWorkgroupSize,
                            1, 1);
    }
    else
    {
      // run the workgroups
      vkCmdDrawMeshTasksIndirectEXT(cmd, m_indirect.buffer, offsetof(shaderio::IndirectParams, groupCountX), 1,
                                    sizeof(VkDrawMeshTasksIndirectCommandEXT));
    }
  }
}

void GaussianSplatting::drawMeshPrimitives(VkCommandBuffer cmd)
{

  NVVK_DBG_SCOPE(cmd);

  VkDeviceSize offset{0};

  // Drawing all triangles
  vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, m_graphicsPipelineMesh);
  vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, m_pipelineLayout, 0, 1, &m_descriptorSet, 0, nullptr);
  // overrides the pipeline setup for depth test/write
  vkCmdSetDepthWriteEnable(cmd, (VkBool32) true);
  vkCmdSetDepthTestEnable(cmd, (VkBool32) true);

  for(uint32_t sceneInstanceIndex = 0; sceneInstanceIndex < m_meshSetVk.instances.size(); ++sceneInstanceIndex)
  {
    const Instance& inst          = m_meshSetVk.instances[sceneInstanceIndex];
    auto&           model         = m_meshSetVk.meshes[inst.objIndex];
    m_pcRaster.objIndex           = inst.objIndex;
    m_pcRaster.sceneInstanceIndex = sceneInstanceIndex;
    m_pcRaster.modelMatrix        = inst.transform;
    m_pcRaster.modelMatrixInverse = inst.transformInverse;

    vkCmdPushConstants(cmd, m_pipelineLayout,
                       VK_SHADER_STAGE_COMPUTE_BIT | VK_SHADER_STAGE_MESH_BIT_EXT | VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT,
                       0, sizeof(shaderio::PushConstant), &m_pcRaster);
    vkCmdBindVertexBuffers(cmd, 0, 1, &model.vertexBuffer.buffer, &offset);
    vkCmdBindIndexBuffer(cmd, model.indexBuffer.buffer, 0, VK_INDEX_TYPE_UINT32);
    vkCmdDrawIndexed(cmd, model.nbIndices, 1, 0, 0, 0);
  }
}

void GaussianSplatting::collectReadBackValuesIfNeeded(void)
{
  if(m_indirectReadbackHost.buffer != VK_NULL_HANDLE && prmRaster.sortingMethod == SORTING_GPU_SYNC_RADIX && m_canCollectReadback)
  {
    std::memcpy((void*)&m_indirectReadback, (void*)m_indirectReadbackHost.mapping, sizeof(shaderio::IndirectParams));
  }
}

void GaussianSplatting::readBackIndirectParametersIfNeeded(VkCommandBuffer cmd)
{
  NVVK_DBG_SCOPE(cmd);

  if(m_indirectReadbackHost.buffer != VK_NULL_HANDLE && prmRaster.sortingMethod == SORTING_GPU_SYNC_RADIX)
  {
    auto timerSection = m_profilerGpuTimer.cmdFrameSection(cmd, "Indirect readback");

    // ensures m_indirect buffer modified by GPU sort is available for transfer
    VkMemoryBarrier barrier = {VK_STRUCTURE_TYPE_MEMORY_BARRIER};
    barrier.srcAccessMask   = VK_ACCESS_SHADER_WRITE_BIT;
    barrier.dstAccessMask   = VK_ACCESS_TRANSFER_READ_BIT;

    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_2_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_2_TRANSFER_BIT, 0, 1, &barrier,
                         0, NULL, 0, NULL);

    // copy from device to host buffer
    VkBufferCopy bc{.srcOffset = 0, .dstOffset = 0, .size = sizeof(shaderio::IndirectParams)};
    vkCmdCopyBuffer(cmd, m_indirect.buffer, m_indirectReadbackHost.buffer, 1, &bc);

    m_canCollectReadback = true;
  }
}

void GaussianSplatting::requestDepthPngExport(const std::filesystem::path& filename)
{
  if(filename.empty())
    return;
  m_depthExportFilename      = filename;
  m_requestDepthExportPng    = true;
  // Wait one rendered frame so camera interaction settles before capture.
  m_depthExportDelayFrames   = 1;
  m_canCollectDepthReadback  = false;
}

void GaussianSplatting::readBackDepthIfRequested(VkCommandBuffer cmd)
{
  if(!m_requestDepthExportPng)
    return;

  if(m_depthExportDelayFrames > 0)
  {
    m_depthExportDelayFrames--;
    return;
  }

  const VkExtent2D extent = m_gBuffers.getSize();
  if(extent.width == 0 || extent.height == 0)
  {
    LOGW("Depth export skipped: viewport size is zero.\n");
    m_requestDepthExportPng = false;
    if(m_multiViewExport.active)
      finishMultiViewExport();
    return;
  }

  const VkDeviceSize bytesPerPixel = depthBytesPerPixel(m_depthFormat);
  const VkDeviceSize readbackSize  = VkDeviceSize(extent.width) * VkDeviceSize(extent.height) * bytesPerPixel;
  if(m_depthReadbackHost.buffer == VK_NULL_HANDLE || m_depthReadbackHost.bufferSize != readbackSize)
  {
    if(m_depthReadbackHost.buffer != VK_NULL_HANDLE)
    {
      m_alloc.destroyBuffer(m_depthReadbackHost);
    }

    m_alloc.createBuffer(m_depthReadbackHost, readbackSize, VK_BUFFER_USAGE_2_TRANSFER_DST_BIT, VMA_MEMORY_USAGE_AUTO_PREFER_HOST,
                         VMA_ALLOCATION_CREATE_MAPPED_BIT | VMA_ALLOCATION_CREATE_HOST_ACCESS_RANDOM_BIT);
    NVVK_DBG_NAME(m_depthReadbackHost.buffer);
  }

  const VkImageSubresourceRange depthRange{
      VK_IMAGE_ASPECT_DEPTH_BIT, 0, VK_REMAINING_MIP_LEVELS, 0, VK_REMAINING_ARRAY_LAYERS};

  nvvk::cmdImageMemoryBarrier(cmd, {m_gBuffers.getDepthImage(), VK_IMAGE_LAYOUT_GENERAL, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, depthRange});

  VkBufferImageCopy region{};
  region.bufferOffset                    = 0;
  region.bufferRowLength                 = 0;
  region.bufferImageHeight               = 0;
  region.imageSubresource.aspectMask     = VK_IMAGE_ASPECT_DEPTH_BIT;
  region.imageSubresource.mipLevel       = 0;
  region.imageSubresource.baseArrayLayer = 0;
  region.imageSubresource.layerCount     = 1;
  region.imageOffset                     = {0, 0, 0};
  region.imageExtent                     = {extent.width, extent.height, 1};
  vkCmdCopyImageToBuffer(cmd, m_gBuffers.getDepthImage(), VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, m_depthReadbackHost.buffer, 1, &region);

  nvvk::cmdImageMemoryBarrier(cmd, {m_gBuffers.getDepthImage(), VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, VK_IMAGE_LAYOUT_GENERAL, depthRange});

  m_depthReadbackExtent     = extent;
  m_canCollectDepthReadback = true;
  m_requestDepthExportPng   = false;
}

void GaussianSplatting::collectDepthReadBackIfNeeded()
{
  if(!m_canCollectDepthReadback || m_depthReadbackHost.mapping == nullptr)
    return;

  const uint32_t width  = m_depthReadbackExtent.width;
  const uint32_t height = m_depthReadbackExtent.height;
  if(width == 0 || height == 0)
  {
    m_canCollectDepthReadback = false;
    return;
  }

  const auto*  depthBytes = reinterpret_cast<const uint8_t*>(m_depthReadbackHost.mapping);
  const size_t pixelCount = size_t(width) * size_t(height);
  const size_t depthBpp   = size_t(depthBytesPerPixel(m_depthFormat));

  std::vector<float> depthNorm(pixelCount, 1.0F);

  float  minDepth     = std::numeric_limits<float>::max();
  float  maxDepth     = 0.0F;
  size_t foregroundPx = 0;
  for(size_t i = 0; i < pixelCount; ++i)
  {
    const float d = decodeDepthValue(depthBytes + i * depthBpp, m_depthFormat);
    if(std::isfinite(d))
    {
      const float dc = std::clamp(d, 0.0F, 1.0F);
      depthNorm[i]   = dc;
      // Ignore far background in auto-range, keeps foreground visible.
      if(dc < 0.9995F)
      {
        minDepth = std::min(minDepth, dc);
        maxDepth = std::max(maxDepth, dc);
        foregroundPx++;
      }
    }
  }

  // Fallback to global range if scene is mostly/entirely background.
  if(foregroundPx == 0 || minDepth >= maxDepth)
  {
    minDepth = std::numeric_limits<float>::max();
    maxDepth = 0.0F;
    for(size_t i = 0; i < pixelCount; ++i)
    {
      const float dc = depthNorm[i];
      if(std::isfinite(dc))
      {
        minDepth = std::min(minDepth, dc);
        maxDepth = std::max(maxDepth, dc);
      }
    }
  }

  if(minDepth >= maxDepth)
  {
    minDepth = 0.0F;
    maxDepth = 1.0F;
  }

  const float invRange = 1.0F / std::max(maxDepth - minDepth, 1e-6F);

  std::vector<uint8_t> rgba(pixelCount * 4, 255);
  for(size_t i = 0; i < pixelCount; ++i)
  {
    const float d = depthNorm[i];
    float       n = 0.0F;
    if(std::isfinite(d))
    {
      n = std::clamp((d - minDepth) * invRange, 0.0F, 1.0F);
    }
    // near objects appear brighter in visualization.
    const float   c = std::sqrt(std::clamp(1.0F - n, 0.0F, 1.0F));
    const uint8_t v = static_cast<uint8_t>(c * 255.0F);
    rgba[i * 4 + 0] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }

  LOGI("Depth export stats: format=%d foreground=%llu/%llu range=[%.6f, %.6f]\n", int(m_depthFormat),
       static_cast<unsigned long long>(foregroundPx), static_cast<unsigned long long>(pixelCount), minDepth, maxDepth);

  if(!m_depthExportFilename.empty())
  {
    std::error_code ec;
    std::filesystem::create_directories(m_depthExportFilename.parent_path(), ec);

    const std::string filenameUtf8 = nvutils::utf8FromPath(m_depthExportFilename);
    if(stbi_write_png(filenameUtf8.c_str(), int(width), int(height), 4, rgba.data(), int(width) * 4) == 0)
    {
      LOGE("Depth export failed: %s\n", filenameUtf8.c_str());
    }
    else
    {
      LOGI("Depth map exported to %s\n", filenameUtf8.c_str());
      m_exportPreviewNotify = ExportPreviewNotify::Depth;
    }
  }

  m_depthExportFilename.clear();
  m_canCollectDepthReadback = false;
  onMultiViewCollectFinished();
}

namespace {

void segIdToRgb(uint32_t id, uint8_t& r, uint8_t& g, uint8_t& b)
{
  // SEG_ID_* are #defines in shaderio.h (not namespace members); do not use shaderio:: prefix.
  switch(id)
  {
    case SEG_ID_BACKGROUND:
      r = g = b = 0;
      return;
    case SEG_ID_SPLAT_SCENE:
      r = 220;
      g = 60;
      b = 60;
      return;
    default: {
      const uint32_t h = id * 2654435761u;
      r                = uint8_t(80 + (h & 0x7F));
      g                = uint8_t(80 + ((h >> 8) & 0x7F));
      b                = uint8_t(80 + ((h >> 16) & 0x7F));
      return;
    }
  }
}

}  // namespace

void GaussianSplatting::requestSegPngExport(const std::filesystem::path& filename)
{
  if(filename.empty())
    return;
  m_segExportFilename      = filename;
  m_requestSegExportPng    = true;
  m_segExportDelayFrames   = 1;
  m_canCollectSegReadback  = false;
}

void GaussianSplatting::clearSegBuffer(VkCommandBuffer cmd)
{
  const VkExtent2D extent = m_gBuffers.getSize();
  if(extent.width == 0 || extent.height == 0)
    return;

  const VkImageSubresourceRange colorRange{VK_IMAGE_ASPECT_COLOR_BIT, 0, VK_REMAINING_MIP_LEVELS, 0, VK_REMAINING_ARRAY_LAYERS};
  nvvk::cmdImageMemoryBarrier(cmd, {m_gBuffers.getColorImage(COLOR_SEG), VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL, colorRange});

  const VkClearColorValue clearValue{{0.0F, 0.0F, 0.0F, 0.0F}};
  vkCmdClearColorImage(cmd, m_gBuffers.getColorImage(COLOR_SEG), VK_IMAGE_LAYOUT_GENERAL, &clearValue, 1, &colorRange);
}

void GaussianSplatting::readBackSegIfRequested(VkCommandBuffer cmd)
{
  if(!m_requestSegExportPng)
    return;

  if(m_segExportDelayFrames > 0)
  {
    m_segExportDelayFrames--;
    return;
  }

  const VkExtent2D extent = m_gBuffers.getSize();
  if(extent.width == 0 || extent.height == 0)
  {
    LOGW("Seg export skipped: viewport size is zero.\n");
    m_requestSegExportPng = false;
    if(m_multiViewExport.active)
      finishMultiViewExport();
    return;
  }

  const VkDeviceSize readbackSize = VkDeviceSize(extent.width) * VkDeviceSize(extent.height) * sizeof(uint32_t);
  if(m_segReadbackHost.buffer == VK_NULL_HANDLE || m_segReadbackHost.bufferSize != readbackSize)
  {
    if(m_segReadbackHost.buffer != VK_NULL_HANDLE)
      m_alloc.destroyBuffer(m_segReadbackHost);

    m_alloc.createBuffer(m_segReadbackHost, readbackSize, VK_BUFFER_USAGE_2_TRANSFER_DST_BIT, VMA_MEMORY_USAGE_AUTO_PREFER_HOST,
                         VMA_ALLOCATION_CREATE_MAPPED_BIT | VMA_ALLOCATION_CREATE_HOST_ACCESS_RANDOM_BIT);
    NVVK_DBG_NAME(m_segReadbackHost.buffer);
  }

  const VkImageSubresourceRange colorRange{VK_IMAGE_ASPECT_COLOR_BIT, 0, VK_REMAINING_MIP_LEVELS, 0, VK_REMAINING_ARRAY_LAYERS};

  nvvk::cmdImageMemoryBarrier(cmd, {m_gBuffers.getColorImage(COLOR_SEG), VK_IMAGE_LAYOUT_GENERAL, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, colorRange});

  VkBufferImageCopy region{};
  region.imageSubresource.aspectMask     = VK_IMAGE_ASPECT_COLOR_BIT;
  region.imageSubresource.mipLevel       = 0;
  region.imageSubresource.baseArrayLayer = 0;
  region.imageSubresource.layerCount     = 1;
  region.imageExtent                     = {extent.width, extent.height, 1};
  vkCmdCopyImageToBuffer(cmd, m_gBuffers.getColorImage(COLOR_SEG), VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, m_segReadbackHost.buffer, 1,
                         &region);

  nvvk::cmdImageMemoryBarrier(cmd, {m_gBuffers.getColorImage(COLOR_SEG), VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, VK_IMAGE_LAYOUT_GENERAL,
                                    colorRange});

  m_segReadbackExtent    = extent;
  m_canCollectSegReadback = true;
  m_requestSegExportPng  = false;
}

void GaussianSplatting::collectSegReadBackIfNeeded()
{
  if(!m_canCollectSegReadback || m_segReadbackHost.mapping == nullptr)
    return;

  const uint32_t width  = m_segReadbackExtent.width;
  const uint32_t height = m_segReadbackExtent.height;
  if(width == 0 || height == 0)
  {
    m_canCollectSegReadback = false;
    return;
  }

  const auto*  segIds     = reinterpret_cast<const uint32_t*>(m_segReadbackHost.mapping);
  const size_t pixelCount = size_t(width) * size_t(height);

  uint32_t maxId = 0;
  for(size_t i = 0; i < pixelCount; ++i)
    maxId = std::max(maxId, segIds[i]);

  std::vector<uint8_t> rgba(pixelCount * 4, 255);
  for(size_t i = 0; i < pixelCount; ++i)
  {
    uint8_t r = 0;
    uint8_t g = 0;
    uint8_t b = 0;
    segIdToRgb(segIds[i], r, g, b);
    rgba[i * 4 + 0] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }

  LOGI("Seg export stats: maxId=%u meshInstances=%zu\n", maxId, m_meshSetVk.instances.size());

  if(!m_segExportFilename.empty())
  {
    std::error_code ec;
    std::filesystem::create_directories(m_segExportFilename.parent_path(), ec);

    const std::string filenameUtf8 = nvutils::utf8FromPath(m_segExportFilename);
    if(stbi_write_png(filenameUtf8.c_str(), int(width), int(height), 4, rgba.data(), int(width) * 4) == 0)
      LOGE("Seg export failed: %s\n", filenameUtf8.c_str());
    else
    {
      LOGI("Segmentation map exported to %s\n", filenameUtf8.c_str());
      m_exportPreviewNotify = ExportPreviewNotify::Seg;
    }
  }

  m_segExportFilename.clear();
  m_canCollectSegReadback = false;
  onMultiViewCollectFinished();
}

void GaussianSplatting::requestRgbPngExport(const std::filesystem::path& filename)
{
  if(filename.empty())
    return;
  m_rgbExportFilename      = filename;
  m_requestRgbExportPng    = true;
  m_rgbExportDelayFrames   = 1;
  m_canCollectRgbReadback  = false;
}

void GaussianSplatting::readBackRgbIfRequested(VkCommandBuffer cmd)
{
  if(!m_requestRgbExportPng)
    return;

  if(m_rgbExportDelayFrames > 0)
  {
    m_rgbExportDelayFrames--;
    return;
  }

  const VkExtent2D extent = m_gBuffers.getSize();
  if(extent.width == 0 || extent.height == 0)
  {
    LOGW("RGB export skipped: viewport size is zero.\n");
    m_requestRgbExportPng = false;
    if(m_multiViewExport.active)
      finishMultiViewExport();
    return;
  }

  const VkDeviceSize readbackSize = VkDeviceSize(extent.width) * VkDeviceSize(extent.height) * 4;
  if(m_rgbReadbackHost.buffer == VK_NULL_HANDLE || m_rgbReadbackHost.bufferSize != readbackSize)
  {
    if(m_rgbReadbackHost.buffer != VK_NULL_HANDLE)
      m_alloc.destroyBuffer(m_rgbReadbackHost);

    m_alloc.createBuffer(m_rgbReadbackHost, readbackSize, VK_BUFFER_USAGE_2_TRANSFER_DST_BIT, VMA_MEMORY_USAGE_AUTO_PREFER_HOST,
                         VMA_ALLOCATION_CREATE_MAPPED_BIT | VMA_ALLOCATION_CREATE_HOST_ACCESS_RANDOM_BIT);
    NVVK_DBG_NAME(m_rgbReadbackHost.buffer);
  }

  const VkImageSubresourceRange colorRange{VK_IMAGE_ASPECT_COLOR_BIT, 0, VK_REMAINING_MIP_LEVELS, 0, VK_REMAINING_ARRAY_LAYERS};

  nvvk::cmdImageMemoryBarrier(cmd, {m_gBuffers.getColorImage(COLOR_MAIN), VK_IMAGE_LAYOUT_GENERAL, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                                    colorRange});

  VkBufferImageCopy region{};
  region.imageSubresource.aspectMask     = VK_IMAGE_ASPECT_COLOR_BIT;
  region.imageSubresource.mipLevel       = 0;
  region.imageSubresource.baseArrayLayer = 0;
  region.imageSubresource.layerCount     = 1;
  region.imageExtent                     = {extent.width, extent.height, 1};
  vkCmdCopyImageToBuffer(cmd, m_gBuffers.getColorImage(COLOR_MAIN), VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, m_rgbReadbackHost.buffer, 1,
                         &region);

  nvvk::cmdImageMemoryBarrier(cmd, {m_gBuffers.getColorImage(COLOR_MAIN), VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, VK_IMAGE_LAYOUT_GENERAL,
                                    colorRange});

  m_rgbReadbackExtent     = extent;
  m_canCollectRgbReadback = true;
  m_requestRgbExportPng   = false;
}

void GaussianSplatting::collectRgbReadBackIfNeeded()
{
  if(!m_canCollectRgbReadback || m_rgbReadbackHost.mapping == nullptr)
    return;

  const uint32_t width  = m_rgbReadbackExtent.width;
  const uint32_t height = m_rgbReadbackExtent.height;
  if(width == 0 || height == 0)
  {
    m_canCollectRgbReadback = false;
    return;
  }

  if(!m_rgbExportFilename.empty())
  {
    std::error_code ec;
    std::filesystem::create_directories(m_rgbExportFilename.parent_path(), ec);

    const std::string filenameUtf8 = nvutils::utf8FromPath(m_rgbExportFilename);
    if(stbi_write_png(filenameUtf8.c_str(), int(width), int(height), 4, m_rgbReadbackHost.mapping, int(width) * 4) == 0)
      LOGE("RGB export failed: %s\n", filenameUtf8.c_str());
    else
      LOGI("RGB image exported to %s\n", filenameUtf8.c_str());
  }

  m_rgbExportFilename.clear();
  m_canCollectRgbReadback = false;
  onMultiViewCollectFinished();
}

namespace {

const char* pipelineName(int pipeline)
{
  switch(pipeline)
  {
    case PIPELINE_VERT:
      return "VERT";
    case PIPELINE_MESH:
      return "MESH";
    case PIPELINE_RTX:
      return "RTX";
    case PIPELINE_HYBRID:
      return "HYBRID";
    case PIPELINE_MESH_3DGUT:
      return "MESH_3DGUT";
    case PIPELINE_HYBRID_3DGUT:
      return "HYBRID_3DGUT";
    default:
      return "UNKNOWN";
  }
}

nlohmann::json mat4ToJson(const glm::mat4& m)
{
  nlohmann::json rows = nlohmann::json::array();
  for(int row = 0; row < 4; ++row)
  {
    nlohmann::json rowArr = nlohmann::json::array();
    for(int col = 0; col < 4; ++col)
      rowArr.push_back(m[col][row]);
    rows.push_back(rowArr);
  }
  return rows;
}

std::filesystem::path makeMultiViewViewDir(const std::filesystem::path& sessionDir, size_t viewIdx)
{
  std::ostringstream oss;
  oss << "view_" << std::setw(3) << std::setfill('0') << viewIdx;
  return sessionDir / oss.str();
}

}  // namespace

std::string GaussianSplatting::multiViewExportStatus() const
{
  if(!m_multiViewExport.active)
    return "Idle";

  const size_t total = m_multiViewExport.presetIndices.size();
  if(m_multiViewExport.phase == MultiViewPhase::WaitSettle)
    return "Switching camera " + std::to_string(m_multiViewExport.viewIdx + 1) + "/" + std::to_string(total) + "...";

  if(m_multiViewExport.phase == MultiViewPhase::WaitCapture)
    return "Capturing view " + std::to_string(m_multiViewExport.viewIdx + 1) + "/" + std::to_string(total) + "...";

  return "Exporting...";
}

void GaussianSplatting::requestMultiViewExport(const std::filesystem::path& sessionDir)
{
  if(m_multiViewExport.active)
  {
    LOGW("Multi-view export already in progress.\n");
    return;
  }

  if(m_cameraSet.size() <= 1)
  {
    LOGW("Multi-view export needs at least one stored camera preset. Use Store in the Camera panel.\n");
    return;
  }

  if(sessionDir.empty())
  {
    LOGW("Multi-view export session directory is empty.\n");
    return;
  }

  const VkExtent2D extent = m_gBuffers.getSize();
  if(extent.width == 0 || extent.height == 0)
  {
    LOGW("Multi-view export skipped: viewport size is zero.\n");
    return;
  }

  m_multiViewExport = MultiViewExportState{};
  m_multiViewExport.active              = true;
  m_multiViewExport.sessionDir          = sessionDir;
  m_multiViewExport.sessionTimestamp    = sessionDir.filename().string();
  m_multiViewExport.savedTemporalSampling = prmRtx.temporalSampling;
  prmRtx.temporalSampling               = false;

  for(uint64_t i = 1; i < m_cameraSet.size(); ++i)
    m_multiViewExport.presetIndices.push_back(i);

  std::error_code ec;
  std::filesystem::create_directories(sessionDir, ec);

  LOGI("Multi-view export started: %zu views -> %s\n", m_multiViewExport.presetIndices.size(),
       nvutils::utf8FromPath(sessionDir).c_str());

  beginMultiViewCapture();
}

void GaussianSplatting::beginMultiViewCapture()
{
  if(m_multiViewExport.viewIdx >= m_multiViewExport.presetIndices.size())
  {
    writeMultiViewManifest();
    m_lastMultiViewSessionDir = m_multiViewExport.sessionDir;
    m_exportPreviewNotify     = ExportPreviewNotify::MultiView;
    finishMultiViewExport();
    return;
  }

  m_multiViewExport.currentPreset = m_multiViewExport.presetIndices[m_multiViewExport.viewIdx];
  m_multiViewExport.currentViewDir = makeMultiViewViewDir(m_multiViewExport.sessionDir, m_multiViewExport.viewIdx);

  std::error_code ec;
  std::filesystem::create_directories(m_multiViewExport.currentViewDir, ec);

  m_cameraSet.loadPreset(m_multiViewExport.currentPreset, true);
  m_multiViewExport.currentCamera = m_cameraSet.getPreset(m_multiViewExport.currentPreset);
  resetFrameCounter();

  m_multiViewExport.phase        = MultiViewPhase::WaitSettle;
  m_multiViewExport.settleFrames = 2;
}

void GaussianSplatting::tickMultiViewExport()
{
  if(!m_multiViewExport.active || m_multiViewExport.phase != MultiViewPhase::WaitSettle)
    return;

  if(m_multiViewExport.settleFrames > 0)
  {
    m_multiViewExport.settleFrames--;
    return;
  }

  scheduleMultiViewCapture();
  m_multiViewExport.phase = MultiViewPhase::WaitCapture;
}

void GaussianSplatting::scheduleMultiViewCapture()
{
  const std::filesystem::path viewDir = m_multiViewExport.currentViewDir;

  requestRgbPngExport(viewDir / "rgb.png");
  requestDepthPngExport(viewDir / "depth.png");
  requestSegPngExport(viewDir / "seg.png");
  m_multiViewExport.pendingCollects = 3;
}

void GaussianSplatting::onMultiViewCollectFinished()
{
  if(!m_multiViewExport.active || m_multiViewExport.phase != MultiViewPhase::WaitCapture)
    return;

  if(m_multiViewExport.pendingCollects > 0)
    m_multiViewExport.pendingCollects--;

  if(m_multiViewExport.pendingCollects > 0)
    return;

  finishMultiViewView();
}

void GaussianSplatting::writeMultiViewCameraJson(const std::filesystem::path& path) const
{
  const Camera& cam = m_multiViewExport.currentCamera;
  const VkExtent2D extent = m_gBuffers.getSize();

  nlohmann::json item;
  item["presetIndex"] = m_multiViewExport.currentPreset;
  item["model"]       = cam.model;
  item["eye"]         = {cam.eye.x, cam.eye.y, cam.eye.z};
  item["ctr"]         = {cam.ctr.x, cam.ctr.y, cam.ctr.z};
  item["up"]          = {cam.up.x, cam.up.y, cam.up.z};
  item["fov"]         = cam.fov;
  item["clip"]        = {cam.clip.x, cam.clip.y};
  item["dofEnabled"]  = cam.dofEnabled;
  item["focusDist"]   = cam.focusDist;
  item["aperture"]    = cam.aperture;
  item["width"]       = extent.width;
  item["height"]      = extent.height;
  item["viewMatrix"]  = mat4ToJson(cameraManip->getViewMatrix());
  item["projectionMatrix"] = mat4ToJson(cameraManip->getPerspectiveMatrix());

  std::ofstream out(path);
  if(!out.is_open())
  {
    LOGE("Failed to write camera.json: %s\n", nvutils::utf8FromPath(path).c_str());
    return;
  }
  out << item.dump(2);
}

void GaussianSplatting::finishMultiViewView()
{
  writeMultiViewCameraJson(m_multiViewExport.currentViewDir / "camera.json");

  nlohmann::json viewEntry;
  viewEntry["viewIndex"]   = m_multiViewExport.viewIdx;
  viewEntry["presetIndex"] = m_multiViewExport.currentPreset;
  viewEntry["folder"]      = m_multiViewExport.currentViewDir.filename().string();
  viewEntry["files"]       = nlohmann::json::array({"rgb.png", "depth.png", "seg.png", "camera.json"});
  m_multiViewExport.manifestViews.push_back(viewEntry);

  LOGI("Multi-view export finished view %zu/%zu (preset %llu)\n", m_multiViewExport.viewIdx + 1,
       m_multiViewExport.presetIndices.size(), static_cast<unsigned long long>(m_multiViewExport.currentPreset));

  m_multiViewExport.viewIdx++;
  beginMultiViewCapture();
}

void GaussianSplatting::writeMultiViewManifest() const
{
  const VkExtent2D extent = m_gBuffers.getSize();

  nlohmann::json manifest;
  manifest["version"]   = 1;
  manifest["timestamp"] = m_multiViewExport.sessionTimestamp;
  manifest["scene"]     = m_loadedSceneFilename.filename().string();
  manifest["pipeline"]  = pipelineName(prmSelectedPipeline);
  manifest["resolution"] = {{"width", extent.width}, {"height", extent.height}};
  manifest["views"]     = m_multiViewExport.manifestViews;

  const std::filesystem::path manifestPath = m_multiViewExport.sessionDir / "manifest.json";
  std::ofstream               out(manifestPath);
  if(!out.is_open())
  {
    LOGE("Failed to write manifest.json: %s\n", nvutils::utf8FromPath(manifestPath).c_str());
    return;
  }
  out << manifest.dump(2);
  LOGI("Multi-view manifest written to %s\n", nvutils::utf8FromPath(manifestPath).c_str());
}

void GaussianSplatting::finishMultiViewExport()
{
  prmRtx.temporalSampling = m_multiViewExport.savedTemporalSampling;
  m_multiViewExport       = MultiViewExportState{};
  LOGI("Multi-view export complete.\n");
}

ExportPreviewNotify GaussianSplatting::consumeExportPreviewNotify()
{
  const ExportPreviewNotify notify = m_exportPreviewNotify;
  m_exportPreviewNotify              = ExportPreviewNotify::None;
  return notify;
}

void GaussianSplatting::updateRenderingMemoryStatistics(VkCommandBuffer cmd, const uint32_t splatCount)
{
  // update rendering memory statistics
  if(prmRaster.sortingMethod != SORTING_GPU_SYNC_RADIX)
  {
    m_renderMemoryStats.hostAllocIndices   = splatCount * sizeof(uint32_t);
    m_renderMemoryStats.hostAllocDistances = splatCount * sizeof(uint32_t);
    m_renderMemoryStats.allocIndices       = splatCount * sizeof(uint32_t);
    m_renderMemoryStats.usedIndices        = splatCount * sizeof(uint32_t);
    m_renderMemoryStats.allocDistances     = 0;
    m_renderMemoryStats.usedDistances      = 0;
    m_renderMemoryStats.usedIndirect       = 0;
  }
  else
  {
    m_renderMemoryStats.hostAllocDistances = 0;
    m_renderMemoryStats.hostAllocIndices   = 0;
    m_renderMemoryStats.allocDistances     = splatCount * sizeof(uint32_t);
    m_renderMemoryStats.usedDistances      = m_indirectReadback.instanceCount * sizeof(uint32_t);
    m_renderMemoryStats.allocIndices       = splatCount * sizeof(uint32_t);
    m_renderMemoryStats.usedIndices        = m_indirectReadback.instanceCount * sizeof(uint32_t);
    if(prmSelectedPipeline == PIPELINE_VERT)
    {
      m_renderMemoryStats.usedIndirect = 5 * sizeof(uint32_t);
    }
    else
    {
      m_renderMemoryStats.usedIndirect = sizeof(shaderio::IndirectParams);
    }
  }
  m_renderMemoryStats.usedUboFrameInfo = sizeof(shaderio::FrameInfo);
  //
  m_renderMemoryStats.rasterHostTotal =
      m_renderMemoryStats.hostAllocIndices + m_renderMemoryStats.hostAllocDistances + m_renderMemoryStats.usedUboFrameInfo;

  uint64_t vrdxSize = prmRaster.sortingMethod != SORTING_GPU_SYNC_RADIX ? 0 : m_renderMemoryStats.allocVdrxInternal;

  m_renderMemoryStats.rasterDeviceUsedTotal = m_renderMemoryStats.usedIndices + m_renderMemoryStats.usedDistances + vrdxSize
                                              + m_renderMemoryStats.usedIndirect + m_renderMemoryStats.usedUboFrameInfo;

  m_renderMemoryStats.rasterDeviceAllocTotal = m_renderMemoryStats.allocIndices + m_renderMemoryStats.allocDistances + vrdxSize
                                               + m_renderMemoryStats.usedIndirect + m_renderMemoryStats.usedUboFrameInfo;

  // RTX Acceleration Structures
  m_renderMemoryStats.rtxUsedTlas = m_splatSetVk.tlasSizeBytes;
  m_renderMemoryStats.rtxUsedBlas = m_splatSetVk.blasSizeBytes;

  m_renderMemoryStats.rtxHostTotal        = 0;
  m_renderMemoryStats.rtxDeviceUsedTotal  = m_renderMemoryStats.rtxUsedTlas + m_renderMemoryStats.rtxUsedBlas;
  m_renderMemoryStats.rtxDeviceAllocTotal = m_renderMemoryStats.rtxUsedTlas + m_renderMemoryStats.rtxUsedBlas;

  // Total
  m_renderMemoryStats.hostTotal = m_renderMemoryStats.rasterHostTotal + m_renderMemoryStats.rtxHostTotal;
  m_renderMemoryStats.deviceUsedTotal = m_renderMemoryStats.rasterDeviceUsedTotal + m_renderMemoryStats.rtxDeviceUsedTotal;
  m_renderMemoryStats.deviceAllocTotal = m_renderMemoryStats.rasterDeviceAllocTotal + m_renderMemoryStats.rtxDeviceAllocTotal;
}

void GaussianSplatting::deinitAll()
{
  vkDeviceWaitIdle(m_device);

  m_canCollectReadback = false;
  m_canCollectDepthReadback = false;
  m_requestDepthExportPng   = false;
  m_depthExportDelayFrames  = 0;
  m_depthExportFilename.clear();
  m_canCollectSegReadback = false;
  m_requestSegExportPng   = false;
  m_segExportDelayFrames  = 0;
  m_segExportFilename.clear();
  m_canCollectRgbReadback = false;
  m_requestRgbExportPng   = false;
  m_rgbExportDelayFrames  = 0;
  m_rgbExportFilename.clear();
  if(m_multiViewExport.active)
    finishMultiViewExport();
  deinitScene();
  m_splatSetVk.resetTransform();
  m_splatSetVk.deinitDataStorage();
  m_splatSetVk.rtxDeinitSplatModel();
  m_splatSetVk.rtxDeinitAccelerationStructures();
  m_meshSetVk.deinitDataStorage();
  m_meshSetVk.rtxDeinitAccelerationStructures();
  m_lightSet.deinit();
  m_cameraSet.deinit();
  deinitShaders();
  deinitPipelines();
  deinitRendererBuffers();
  resetRenderSettings();
  // record default cam for reset in UI
  m_cameraSet.setCamera(Camera());
  // record default cam for reset in UI
  m_cameraSet.setHomePreset(m_cameraSet.getCamera());
}

bool GaussianSplatting::initAll()
{
  vkDeviceWaitIdle(m_device);

  // resize the CPU sorter indices buffer
  m_splatIndices.resize(m_splatIndices.size());
  // TODO: use BBox of point cloud to set far plane, eye and center
  m_cameraSet.setCamera(Camera());
  // record default cam for reset in UI
  m_cameraSet.setHomePreset(m_cameraSet.getCamera());
  // reset general parameters
  resetRenderSettings();

  m_lightSet.init(m_app, &m_alloc, &m_uploader);
  // init a new setup
  if(!initShaders())
  {
    return false;
  }
  initRendererBuffers();
  m_splatSetVk.initDataStorage(m_splatSet, prmData.dataStorage, prmData.shFormat);
  initPipelines();

  // RTX specifics
  m_splatSetVk.rtxInitSplatModel(m_splatSet, prmRtxData.useTlasInstances, prmRtxData.useAABBs, prmRtxData.compressBlas,
                                 prmRtx.kernelDegree, prmRtx.kernelMinResponse, prmRtx.kernelAdaptiveClamping);

  m_splatSetVk.rtxInitAccelerationStructures(m_splatSet);

  initRtDescriptorSet();
  initRtPipeline();

  // Post processing
  initDescriptorSetPostProcessing();
  initPipelinePostProcessing();

  return true;
}

void GaussianSplatting::deinitScene()
{
  m_splatSet            = {};
  m_loadedSceneFilename = "";
}

void GaussianSplatting::updateSlangMacros()
{
  m_shaderMacros =  // comment to force clang new line and better indent
      {{"PIPELINE", std::to_string(prmSelectedPipeline)},
       {"HYBRID_ENABLED", std::to_string((int)(prmSelectedPipeline == PIPELINE_HYBRID || prmSelectedPipeline == PIPELINE_HYBRID_3DGUT))},
       {"CAMERA_TYPE", std::to_string(m_cameraSet.getCamera().model)},
       {"VISUALIZE", std::to_string((int)prmRender.visualize)},
       {"DISABLE_OPACITY_GAUSSIAN", std::to_string((int)prmRender.opacityGaussianDisabled)},
       {"FRUSTUM_CULLING_MODE", std::to_string(prmRaster.frustumCulling)},
       // Disabled, TODO do we enable ortho cam in the UI/camera controller
       {"ORTHOGRAPHIC_MODE", "0"},
       {"SHOW_SH_ONLY", std::to_string((int)prmRender.showShOnly)},
       {"MAX_SH_DEGREE", std::to_string(prmRender.maxShDegree)},
       {"DATA_STORAGE", std::to_string(prmData.dataStorage)},
       {"SH_FORMAT", std::to_string(prmData.shFormat)},
       {"POINT_CLOUD_MODE", std::to_string((int)prmRaster.pointCloudModeEnabled)},
       {"USE_BARYCENTRIC", std::to_string((int)prmRaster.fragmentBarycentric)},
       {"WIREFRAME", std::to_string((int)prmRender.wireframe)},
       {"DISTANCE_COMPUTE_WORKGROUP_SIZE", std::to_string((int)prmRaster.distShaderWorkgroupSize)},
       {"RASTER_MESH_WORKGROUP_SIZE", std::to_string((int)prmRaster.meshShaderWorkgroupSize)},
       {"MS_ANTIALIASING", std::to_string((int)prmRaster.msAntialiasing)},
       {"EXTENT_METHOD", std::to_string((int)prmRaster.extentProjection)},
       // RTX
       {"TEMPORAL_SAMPLING", std::to_string((int)prmRtx.temporalSampling)},
       {"KERNEL_DEGREE", std::to_string(prmRtx.kernelDegree)},
       {"KERNEL_MIN_RESPONSE", std::to_string(prmRtx.kernelMinResponse)},
       {"KERNEL_ADAPTIVE_CLAMPING", std::to_string((int)prmRtx.kernelAdaptiveClamping)},
       {"PAYLOAD_ARRAY_SIZE", std::to_string(prmRtx.payloadArraySize)},
       {"RTX_USE_INSTANCES", std::to_string((int)prmRtxData.useTlasInstances)},
       {"RTX_USE_AABBS", std::to_string((int)prmRtxData.useAABBs)},
       {"RTX_USE_MESHES", std::to_string((int)m_meshSetVk.instances.size())},
       {"RTX_DOF_ENABLED", std::to_string((int)m_cameraSet.getCamera().dofEnabled)}};

  m_slangCompiler.clearMacros();

  // then provide the char* strings to the compiler
  for(auto& macro : m_shaderMacros)
  {
    m_slangCompiler.addMacro({macro.first.c_str(), macro.second.c_str()});
  }
}

bool GaussianSplatting::compileSlangShader(const std::string& filename, VkShaderModule& module)
{

  if(!m_slangCompiler.compileFile(filename))
  {
    return false;
  }

  if(module != VK_NULL_HANDLE)
    vkDestroyShaderModule(m_device, module, nullptr);

  // Create the VK module
  VkShaderModuleCreateInfo createInfo{.sType    = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
                                      .codeSize = m_slangCompiler.getSpirvSize(),
                                      .pCode    = m_slangCompiler.getSpirv()};

  if(m_slangCompiler.getSpirvSize() == 0)
  {
    std::cerr << "\033[31m"
              << "Missing entry point in shader " << std::endl;
    std::cerr << filename << "\033[0m" << std::endl;
    return false;
  }
  NVVK_CHECK(vkCreateShaderModule(m_device, &createInfo, nullptr, &module));
  NVVK_DBG_NAME(module);

  m_shaders.modules.emplace_back(&module);

  return true;
}

bool GaussianSplatting::initShaders(void)
{
  auto startTime = std::chrono::high_resolution_clock::now();

  bool success = true;

  updateSlangMacros();

  // Particles distance to viewpoint and frustum culling
  success &= compileSlangShader("dist.comp.slang", m_shaders.distShader);
  // 3DGS raster
  success &= compileSlangShader("threedgs_raster.vert.slang", m_shaders.vertexShader);
  success &= compileSlangShader("threedgs_raster.mesh.slang", m_shaders.meshShader);
  success &= compileSlangShader("threedgs_raster.frag.slang", m_shaders.fragmentShader);
  // 3DGUT raster
  success &= compileSlangShader("threedgut_raster.mesh.slang", m_shaders.threedgutMeshShader);
  success &= compileSlangShader("threedgut_raster.frag.slang", m_shaders.threedgutFragmentShader);
  // Mesh raster
  success &= compileSlangShader("threedmesh_raster.vert.slang", m_shaders.meshVertexShader);
  success &= compileSlangShader("threedmesh_raster.frag.slang", m_shaders.meshFragmentShader);
  // Ray trace
  success &= compileSlangShader("threedgrt_raytrace.rgen.slang", m_shaders.rtxRgenShader);
  success &= compileSlangShader("threedgrt_raytrace.rmiss.slang", m_shaders.rtxRmissShader);
  success &= compileSlangShader("threedgrt_raytrace_shadow.rmiss.slang", m_shaders.rtxRmiss2Shader);
  success &= compileSlangShader("threedgrt_raytrace.rchit.slang", m_shaders.rtxRchitShader);
  success &= compileSlangShader("threedgrt_raytrace.rahit.slang", m_shaders.rtxRahitShader);
  success &= compileSlangShader("threedgrt_raytrace.rint.slang", m_shaders.rtxRintShader);
  // Post processings
  success &= compileSlangShader("post.comp.slang", m_shaders.postComputeShader);

  if(!success)
    return (m_shaders.valid = false);

  auto      endTime   = std::chrono::high_resolution_clock::now();
  long long buildTime = std::chrono::duration_cast<std::chrono::milliseconds>(endTime - startTime).count();
  std::cout << "Shaders updated in " << buildTime << "ms" << std::endl;

  return (m_shaders.valid = true);
}

void GaussianSplatting::deinitShaders(void)
{
  for(auto& shader : m_shaders.modules)
  {
    vkDestroyShaderModule(m_device, *shader, nullptr);
    *shader = VK_NULL_HANDLE;
  }

  m_shaders.valid = false;
  m_shaders.modules.clear();
}

void GaussianSplatting::initPipelines()
{
  nvvk::DescriptorBindings bindings;

  bindings.addBinding(BINDING_FRAME_INFO_UBO, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1, VK_SHADER_STAGE_ALL);
  bindings.addBinding(BINDING_DISTANCES_BUFFER, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_ALL);
  bindings.addBinding(BINDING_INDICES_BUFFER, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_ALL);
  bindings.addBinding(BINDING_INDIRECT_BUFFER, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_ALL);

  if(prmData.dataStorage == STORAGE_TEXTURES)
  {
    bindings.addBinding(BINDING_CENTERS_TEXTURE, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_ALL);
    bindings.addBinding(BINDING_SCALES_TEXTURE, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_ALL);
    bindings.addBinding(BINDING_ROTATIONS_TEXTURE, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_ALL);
    bindings.addBinding(BINDING_COVARIANCES_TEXTURE, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_ALL);

    bindings.addBinding(BINDING_COLORS_TEXTURE, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_ALL);
    bindings.addBinding(BINDING_SH_TEXTURE, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_ALL);
  }
  else
  {
    bindings.addBinding(BINDING_CENTERS_BUFFER, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_ALL);
    bindings.addBinding(BINDING_SCALES_BUFFER, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_ALL);
    bindings.addBinding(BINDING_ROTATIONS_BUFFER, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_ALL);
    bindings.addBinding(BINDING_COVARIANCES_BUFFER, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_ALL);

    bindings.addBinding(BINDING_COLORS_BUFFER, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_ALL);
    bindings.addBinding(BINDING_SH_BUFFER, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_ALL);
  }

  // Obj Mesh objectDescriptions
  bindings.addBinding(BINDING_MESH_DESCRIPTORS, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_ALL);
  bindings.addBinding(BINDING_MESH_INSTANCE_TO_OBJ, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_ALL);
  bindings.addBinding(BINDING_LIGHT_SET, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_ALL);

  //
  const VkPushConstantRange pcRanges = {VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT
                                            | VK_SHADER_STAGE_MESH_BIT_EXT | VK_SHADER_STAGE_COMPUTE_BIT,
                                        0, sizeof(shaderio::PushConstant)};

  NVVK_CHECK(bindings.createDescriptorSetLayout(m_device, 0, &m_descriptorSetLayout));
  NVVK_DBG_NAME(m_descriptorSetLayout);

  //
  std::vector<VkDescriptorPoolSize> poolSize;
  bindings.appendPoolSizes(poolSize);
  VkDescriptorPoolCreateInfo poolInfo = {
      .sType         = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
      .maxSets       = 1,
      .poolSizeCount = uint32_t(poolSize.size()),
      .pPoolSizes    = poolSize.data(),
  };
  NVVK_CHECK(vkCreateDescriptorPool(m_device, &poolInfo, nullptr, &m_descriptorPool));
  NVVK_DBG_NAME(m_descriptorPool);

  VkDescriptorSetAllocateInfo allocInfo = {
      .sType              = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
      .descriptorPool     = m_descriptorPool,
      .descriptorSetCount = 1,
      .pSetLayouts        = &m_descriptorSetLayout,
  };
  NVVK_CHECK(vkAllocateDescriptorSets(m_device, &allocInfo, &m_descriptorSet));
  NVVK_DBG_NAME(m_descriptorSet);

  VkPipelineLayoutCreateInfo plCreateInfo{
      .sType                  = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
      .setLayoutCount         = 1,
      .pSetLayouts            = &m_descriptorSetLayout,
      .pushConstantRangeCount = 1,
      .pPushConstantRanges    = &pcRanges,
  };
  NVVK_CHECK(vkCreatePipelineLayout(m_device, &plCreateInfo, nullptr, &m_pipelineLayout));
  NVVK_DBG_NAME(m_pipelineLayout);

  // Write descriptors for the buffers and textures
  nvvk::WriteSetContainer writeContainer;

  // add common buffers
  writeContainer.append(bindings.getWriteSet(BINDING_FRAME_INFO_UBO, m_descriptorSet), m_frameInfoBuffer);
  writeContainer.append(bindings.getWriteSet(BINDING_DISTANCES_BUFFER, m_descriptorSet), m_splatDistancesDevice);
  writeContainer.append(bindings.getWriteSet(BINDING_INDICES_BUFFER, m_descriptorSet), m_splatIndicesDevice);
  writeContainer.append(bindings.getWriteSet(BINDING_INDIRECT_BUFFER, m_descriptorSet), m_indirect);

  if(prmData.dataStorage == STORAGE_TEXTURES)
  {
    // add data texture maps
    writeContainer.append(bindings.getWriteSet(BINDING_CENTERS_TEXTURE, m_descriptorSet), m_splatSetVk.centersMap);
    writeContainer.append(bindings.getWriteSet(BINDING_SCALES_TEXTURE, m_descriptorSet), m_splatSetVk.scalesMap);
    writeContainer.append(bindings.getWriteSet(BINDING_ROTATIONS_TEXTURE, m_descriptorSet), m_splatSetVk.rotationsMap);
    writeContainer.append(bindings.getWriteSet(BINDING_COVARIANCES_TEXTURE, m_descriptorSet), m_splatSetVk.covariancesMap);

    writeContainer.append(bindings.getWriteSet(BINDING_COLORS_TEXTURE, m_descriptorSet), m_splatSetVk.colorsMap);
    writeContainer.append(bindings.getWriteSet(BINDING_SH_TEXTURE, m_descriptorSet), m_splatSetVk.sphericalHarmonicsMap);
  }
  else
  {
    // add data buffers
    writeContainer.append(bindings.getWriteSet(BINDING_CENTERS_BUFFER, m_descriptorSet), m_splatSetVk.centersBuffer);
    writeContainer.append(bindings.getWriteSet(BINDING_SCALES_BUFFER, m_descriptorSet), m_splatSetVk.scalesBuffer);
    writeContainer.append(bindings.getWriteSet(BINDING_ROTATIONS_BUFFER, m_descriptorSet), m_splatSetVk.rotationsBuffer);
    writeContainer.append(bindings.getWriteSet(BINDING_COVARIANCES_BUFFER, m_descriptorSet), m_splatSetVk.covariancesBuffer);

    writeContainer.append(bindings.getWriteSet(BINDING_COLORS_BUFFER, m_descriptorSet), m_splatSetVk.colorsBuffer);
    if(m_splatSetVk.sphericalHarmonicsBuffer.buffer != NULL)
      writeContainer.append(bindings.getWriteSet(BINDING_SH_BUFFER, m_descriptorSet), m_splatSetVk.sphericalHarmonicsBuffer);
  }

  if(m_meshSetVk.instances.size())
  {
    writeContainer.append(bindings.getWriteSet(BINDING_MESH_DESCRIPTORS, m_descriptorSet),
                          m_meshSetVk.objectDescriptionsBuffer.buffer);
    writeContainer.append(bindings.getWriteSet(BINDING_MESH_INSTANCE_TO_OBJ, m_descriptorSet),
                          m_meshSetVk.instanceToObjIndexBuffer.buffer);
  }

  if(m_lightSet.size())
  {
    writeContainer.append(bindings.getWriteSet(BINDING_LIGHT_SET, m_descriptorSet), m_lightSet.lightsBuffer);
  }

  // write
  vkUpdateDescriptorSets(m_device, static_cast<uint32_t>(writeContainer.size()), writeContainer.data(), 0, nullptr);

  // Create the pipeline to run the compute shader for distance & culling
  {
    VkComputePipelineCreateInfo pipelineInfo{
        .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
        .stage =
            {
                .sType  = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
                .stage  = VK_SHADER_STAGE_COMPUTE_BIT,
                .module = m_shaders.distShader,
                .pName  = "main",
            },
        .layout = m_pipelineLayout,
    };
    vkCreateComputePipelines(m_device, {}, 1, &pipelineInfo, nullptr, &m_computePipelineGsDistCull);
    NVVK_DBG_NAME(m_computePipelineGsDistCull);
  }
  const std::vector<VkFormat> rasterColorFormats = {m_colorFormat, VK_FORMAT_R32_UINT};

  auto applySegAttachmentBlend = [](nvvk::GraphicsPipelineState& state, bool splatAlphaBlend) {
    state.colorBlendEnables     = {splatAlphaBlend ? VK_TRUE : VK_FALSE, VK_FALSE};
    state.colorWriteMasks       = {VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT | VK_COLOR_COMPONENT_B_BIT
                             | VK_COLOR_COMPONENT_A_BIT,
                             VK_COLOR_COMPONENT_R_BIT};
    state.colorBlendEquations.resize(2);
    state.colorBlendEquations[0] = {
        .srcColorBlendFactor = splatAlphaBlend ? VK_BLEND_FACTOR_SRC_ALPHA : VK_BLEND_FACTOR_ONE,
        .dstColorBlendFactor = splatAlphaBlend ? VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA : VK_BLEND_FACTOR_ZERO,
        .colorBlendOp        = VK_BLEND_OP_ADD,
        .srcAlphaBlendFactor = VK_BLEND_FACTOR_ONE,
        .dstAlphaBlendFactor = VK_BLEND_FACTOR_ONE,
        .alphaBlendOp        = VK_BLEND_OP_ADD,
    };
    state.colorBlendEquations[1] = {
        .srcColorBlendFactor = VK_BLEND_FACTOR_ONE,
        .dstColorBlendFactor = VK_BLEND_FACTOR_ZERO,
        .colorBlendOp        = VK_BLEND_OP_ADD,
        .srcAlphaBlendFactor = VK_BLEND_FACTOR_ONE,
        .dstAlphaBlendFactor = VK_BLEND_FACTOR_ZERO,
        .alphaBlendOp        = VK_BLEND_OP_ADD,
    };
  };

  // Create the GS rasterization pipelines
  {
    // Preparing the common states
    nvvk::GraphicsPipelineState pipelineState;
    pipelineState.rasterizationState.cullMode = VK_CULL_MODE_NONE;

    applySegAttachmentBlend(pipelineState, true);

    // By default disable depth write and test for the pipeline
    // Since splats are sorted, screen aligned, and rendered back to front
    // we do not need depth test/write, which leads to faster rendering
    // however since CPU sorting mode is costly we disable it when not visualizing with alpha,
    // only in this case we will use depth test/write. this will be changed dynamically at rendering.
    pipelineState.rasterizationState.cullMode        = VK_CULL_MODE_NONE;
    pipelineState.depthStencilState.depthWriteEnable = VK_FALSE;
    pipelineState.depthStencilState.depthTestEnable  = VK_FALSE;

    // create the pipeline that uses mesh shaders for 3DGS
    {
      nvvk::GraphicsPipelineCreator creator;
      creator.pipelineInfo.layout                  = m_pipelineLayout;
      creator.colorFormats                         = rasterColorFormats;
      creator.renderingState.depthAttachmentFormat = m_depthFormat;
      // The dynamic state is used to change the depth test state dynamically
      creator.dynamicStateValues.push_back(VK_DYNAMIC_STATE_DEPTH_WRITE_ENABLE);
      creator.dynamicStateValues.push_back(VK_DYNAMIC_STATE_DEPTH_TEST_ENABLE);

      creator.addShader(VK_SHADER_STAGE_MESH_BIT_EXT, "main", m_shaders.meshShader);
      creator.addShader(VK_SHADER_STAGE_FRAGMENT_BIT, "main_mesh", m_shaders.fragmentShader);

      creator.createGraphicsPipeline(m_device, nullptr, pipelineState, &m_graphicsPipelineGsMesh);
      NVVK_DBG_NAME(m_graphicsPipelineGsMesh);
    }

    // create the pipeline that uses mesh shaders for 3DGUT
    {
      nvvk::GraphicsPipelineCreator creator;
      creator.pipelineInfo.layout                  = m_pipelineLayout;
      creator.colorFormats                         = rasterColorFormats;
      creator.renderingState.depthAttachmentFormat = m_depthFormat;
      // The dynamic state is used to change the depth test state dynamically
      creator.dynamicStateValues.push_back(VK_DYNAMIC_STATE_DEPTH_WRITE_ENABLE);
      creator.dynamicStateValues.push_back(VK_DYNAMIC_STATE_DEPTH_TEST_ENABLE);

      creator.addShader(VK_SHADER_STAGE_MESH_BIT_EXT, "main", m_shaders.threedgutMeshShader);
      creator.addShader(VK_SHADER_STAGE_FRAGMENT_BIT, "main", m_shaders.threedgutFragmentShader);

      creator.createGraphicsPipeline(m_device, nullptr, pipelineState, &m_graphicsPipeline3dgutMesh);
      NVVK_DBG_NAME(m_graphicsPipeline3dgutMesh);
    }

    // create the pipeline that uses vertex shaders for 3DGS
    {
      const auto BINDING_ATTR_POSITION    = 0;
      const auto BINDING_ATTR_SPLAT_INDEX = 1;

      pipelineState.vertexBindings   = {{// 3 component per vertex position
                                         .binding = BINDING_ATTR_POSITION,
                                         .stride  = 3 * sizeof(float),
                                       //.inputRate = VK_VERTEX_INPUT_RATE_VERTEX,
                                         .divisor = 1},
                                        {// All the vertices of each splat instance will get the same index
                                         .binding   = BINDING_ATTR_SPLAT_INDEX,
                                         .stride    = sizeof(uint32_t),
                                         .inputRate = VK_VERTEX_INPUT_RATE_INSTANCE,
                                         .divisor   = 1}};
      pipelineState.vertexAttributes = {
          {.location = ATTRIBUTE_LOC_POSITION, .binding = BINDING_ATTR_POSITION, .format = VK_FORMAT_R32G32B32_SFLOAT, .offset = 0},
          {.location = ATTRIBUTE_LOC_SPLAT_INDEX, .binding = BINDING_ATTR_SPLAT_INDEX, .format = VK_FORMAT_R32_UINT, .offset = 0}};

      nvvk::GraphicsPipelineCreator creator;
      creator.pipelineInfo.layout                  = m_pipelineLayout;
      creator.colorFormats                         = rasterColorFormats;
      creator.renderingState.depthAttachmentFormat = m_depthFormat;
      // The dynamic state is used to change the depth test state dynamically
      creator.dynamicStateValues.push_back(VK_DYNAMIC_STATE_DEPTH_WRITE_ENABLE);
      creator.dynamicStateValues.push_back(VK_DYNAMIC_STATE_DEPTH_TEST_ENABLE);

      creator.addShader(VK_SHADER_STAGE_VERTEX_BIT, "main", m_shaders.vertexShader);
      creator.addShader(VK_SHADER_STAGE_FRAGMENT_BIT, "main", m_shaders.fragmentShader);

      creator.createGraphicsPipeline(m_device, nullptr, pipelineState, &m_graphicsPipelineGsVert);
      NVVK_DBG_NAME(m_graphicsPipelineGsVert);
    }
  }
  // Create the 3D mesh rasterization pipeline
  {

    // Preparing the pipeline states
    nvvk::GraphicsPipelineState pipelineState;
    pipelineState.rasterizationState.cullMode = VK_CULL_MODE_NONE;

    applySegAttachmentBlend(pipelineState, false);

    // TODOC
    pipelineState.rasterizationState.cullMode        = VK_CULL_MODE_NONE;
    pipelineState.depthStencilState.depthWriteEnable = VK_TRUE;
    pipelineState.depthStencilState.depthTestEnable  = VK_TRUE;

    // create the pipeline
    const auto BINDING_ATTR_VERTEX = 0;

    pipelineState.vertexBindings   = {{// 3 pos and 3 nrm per vertex
                                       .binding = BINDING_ATTR_VERTEX,
                                       .stride  = 6 * sizeof(float),
                                       .divisor = 1}};
    pipelineState.vertexAttributes = {{.location = ATTRIBUTE_LOC_MESH_POSITION,
                                       .binding  = BINDING_ATTR_VERTEX,
                                       .format   = VK_FORMAT_R32G32B32_SFLOAT,
                                       .offset   = static_cast<uint32_t>(offsetof(ObjVertex, pos))},
                                      {.location = ATTRIBUTE_LOC_MESH_NORMAL,
                                       .binding  = BINDING_ATTR_VERTEX,
                                       .format   = VK_FORMAT_R32G32B32_SFLOAT,
                                       .offset   = static_cast<uint32_t>(offsetof(ObjVertex, nrm))}};

    nvvk::GraphicsPipelineCreator creator;
    creator.pipelineInfo.layout                  = m_pipelineLayout;
    creator.colorFormats                         = rasterColorFormats;
    creator.renderingState.depthAttachmentFormat = m_depthFormat;
    // The dynamic state is used to change the depth test state dynamically
    creator.dynamicStateValues.push_back(VK_DYNAMIC_STATE_DEPTH_WRITE_ENABLE);
    creator.dynamicStateValues.push_back(VK_DYNAMIC_STATE_DEPTH_TEST_ENABLE);

    creator.addShader(VK_SHADER_STAGE_VERTEX_BIT, "main", m_shaders.meshVertexShader);
    creator.addShader(VK_SHADER_STAGE_FRAGMENT_BIT, "main", m_shaders.meshFragmentShader);

    creator.createGraphicsPipeline(m_device, nullptr, pipelineState, &m_graphicsPipelineMesh);
    NVVK_DBG_NAME(m_graphicsPipelineMesh);
  }
}

// include RTX one
void GaussianSplatting::deinitPipelines()
{
  if(m_graphicsPipelineGsVert == VK_NULL_HANDLE)
    return;

  TEST_DESTROY_AND_RESET(m_graphicsPipelineGsVert, vkDestroyPipeline(m_device, m_graphicsPipelineGsVert, nullptr));
  TEST_DESTROY_AND_RESET(m_graphicsPipelineGsMesh, vkDestroyPipeline(m_device, m_graphicsPipelineGsMesh, nullptr));
  TEST_DESTROY_AND_RESET(m_graphicsPipeline3dgutMesh, vkDestroyPipeline(m_device, m_graphicsPipeline3dgutMesh, nullptr));
  TEST_DESTROY_AND_RESET(m_graphicsPipelineMesh, vkDestroyPipeline(m_device, m_graphicsPipelineMesh, nullptr));
  TEST_DESTROY_AND_RESET(m_computePipelineGsDistCull, vkDestroyPipeline(m_device, m_computePipelineGsDistCull, nullptr));

  TEST_DESTROY_AND_RESET(m_pipelineLayout, vkDestroyPipelineLayout(m_device, m_pipelineLayout, nullptr));
  TEST_DESTROY_AND_RESET(m_descriptorSetLayout, vkDestroyDescriptorSetLayout(m_device, m_descriptorSetLayout, nullptr));
  TEST_DESTROY_AND_RESET(m_descriptorPool, vkDestroyDescriptorPool(m_device, m_descriptorPool, nullptr));

  // RTX TODO move this in rtDeinitPipeline and invoke in proper location
  TEST_DESTROY_AND_RESET(m_rtPipeline, vkDestroyPipeline(m_device, m_rtPipeline, nullptr));

  TEST_DESTROY_AND_RESET(m_rtPipelineLayout, vkDestroyPipelineLayout(m_device, m_rtPipelineLayout, nullptr));
  TEST_DESTROY_AND_RESET(m_rtDescriptorPool, vkDestroyDescriptorPool(m_device, m_rtDescriptorPool, nullptr));
  TEST_DESTROY_AND_RESET(m_rtDescriptorSetLayout, vkDestroyDescriptorSetLayout(m_device, m_rtDescriptorSetLayout, nullptr));

  m_alloc.destroyBuffer(m_rtSBTBuffer);
  m_rtShaderGroups.clear();

  // Post process
  TEST_DESTROY_AND_RESET(m_computePipelinePostProcess, vkDestroyPipeline(m_device, m_computePipelinePostProcess, nullptr));

  TEST_DESTROY_AND_RESET(m_pipelineLayoutPostProcess, vkDestroyPipelineLayout(m_device, m_pipelineLayoutPostProcess, nullptr));
  TEST_DESTROY_AND_RESET(m_descriptorPoolPostProcess, vkDestroyDescriptorPool(m_device, m_descriptorPoolPostProcess, nullptr));
  TEST_DESTROY_AND_RESET(m_descriptorSetLayoutPostProcess,
                         vkDestroyDescriptorSetLayout(m_device, m_descriptorSetLayoutPostProcess, nullptr));
}

void GaussianSplatting::initRendererBuffers()
{
  const auto splatCount = (uint32_t)m_splatSet.size();

  // All this block for the sorting
  {
    // Vrdx sorter
    VrdxSorterCreateInfo gpuSorterInfo{.physicalDevice = m_app->getPhysicalDevice(), .device = m_app->getDevice()};
    vrdxCreateSorter(&gpuSorterInfo, &m_gpuSorter);

    {  // Create some buffer for GPU and/or CPU sorting
      // shall use minStorageBufferOffsetAlignment
      const VkDeviceSize bufferSize = ((splatCount * sizeof(uint32_t) + 15) / 16) * 16;

      m_alloc.createBuffer(m_splatIndicesHost, bufferSize, VK_BUFFER_USAGE_2_TRANSFER_SRC_BIT, VMA_MEMORY_USAGE_AUTO_PREFER_HOST,
                           VMA_ALLOCATION_CREATE_MAPPED_BIT | VMA_ALLOCATION_CREATE_HOST_ACCESS_SEQUENTIAL_WRITE_BIT);

      m_alloc.createBuffer(m_splatIndicesDevice, bufferSize,
                           VK_BUFFER_USAGE_2_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_2_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_2_TRANSFER_DST_BIT
                               | VK_BUFFER_USAGE_2_SHADER_DEVICE_ADDRESS_BIT | VK_BUFFER_USAGE_2_VERTEX_BUFFER_BIT,
                           VMA_MEMORY_USAGE_AUTO_PREFER_DEVICE);

      m_alloc.createBuffer(m_splatDistancesDevice, bufferSize,
                           VK_BUFFER_USAGE_2_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_2_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_2_TRANSFER_DST_BIT
                               | VK_BUFFER_USAGE_2_SHADER_DEVICE_ADDRESS_BIT | VK_BUFFER_USAGE_2_VERTEX_BUFFER_BIT,
                           VMA_MEMORY_USAGE_AUTO_PREFER_DEVICE);

      VrdxSorterStorageRequirements requirements;
      vrdxGetSorterKeyValueStorageRequirements(m_gpuSorter, splatCount, &requirements);
      m_alloc.createBuffer(m_vrdxStorageDevice, requirements.size, requirements.usage, VMA_MEMORY_USAGE_AUTO_PREFER_DEVICE);

      // for stats reporting only
      m_renderMemoryStats.allocVdrxInternal = (uint32_t)requirements.size;

      // generate debug information for buffers
      NVVK_DBG_NAME(m_splatIndicesHost.buffer);
      NVVK_DBG_NAME(m_splatIndicesDevice.buffer);
      NVVK_DBG_NAME(m_splatDistancesDevice.buffer);
      NVVK_DBG_NAME(m_vrdxStorageDevice.buffer);
    }
  }

  // create the device buffer for indirect parameters
  m_alloc.createBuffer(m_indirect, sizeof(shaderio::IndirectParams),
                       VK_BUFFER_USAGE_2_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_2_TRANSFER_SRC_BIT
                           | VK_BUFFER_USAGE_2_TRANSFER_DST_BIT | VK_BUFFER_USAGE_2_INDIRECT_BUFFER_BIT,
                       VMA_MEMORY_USAGE_AUTO_PREFER_DEVICE);

  // for statistics readback
  m_alloc.createBuffer(m_indirectReadbackHost, sizeof(shaderio::IndirectParams),
                       VK_BUFFER_USAGE_2_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_2_TRANSFER_DST_BIT, VMA_MEMORY_USAGE_AUTO_PREFER_HOST,
                       VMA_ALLOCATION_CREATE_MAPPED_BIT | VMA_ALLOCATION_CREATE_HOST_ACCESS_SEQUENTIAL_WRITE_BIT);

  NVVK_DBG_NAME(m_indirect.buffer);
  NVVK_DBG_NAME(m_indirectReadbackHost.buffer);

  // We create a command buffer in order to perform the copy to VRAM
  VkCommandBuffer cmd = m_app->createTempCmdBuffer();

  // The Quad
  const std::vector<uint16_t> indices  = {0, 2, 1, 2, 0, 3};
  const std::vector<float>    vertices = {-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 1.0, 1.0, 0.0, -1.0, 1.0, 0.0};

  // create the quad buffers
  m_alloc.createBuffer(m_quadVertices, vertices.size() * sizeof(float), VK_BUFFER_USAGE_2_VERTEX_BUFFER_BIT,
                       VMA_MEMORY_USAGE_AUTO_PREFER_DEVICE);
  m_alloc.createBuffer(m_quadIndices, indices.size() * sizeof(uint16_t), VK_BUFFER_USAGE_2_INDEX_BUFFER_BIT,
                       VMA_MEMORY_USAGE_AUTO_PREFER_DEVICE);

  NVVK_DBG_NAME(m_quadVertices.buffer);
  NVVK_DBG_NAME(m_quadIndices.buffer);

  // buffers are small so we use vkCmdUpdateBuffer for the transfers
  vkCmdUpdateBuffer(cmd, m_quadVertices.buffer, 0, vertices.size() * sizeof(float), vertices.data());
  vkCmdUpdateBuffer(cmd, m_quadIndices.buffer, 0, indices.size() * sizeof(uint16_t), indices.data());
  m_app->submitAndWaitTempCmdBuffer(cmd);

  // Uniform buffer
  m_alloc.createBuffer(m_frameInfoBuffer, sizeof(shaderio::FrameInfo),
                       VK_BUFFER_USAGE_2_UNIFORM_BUFFER_BIT | VK_BUFFER_USAGE_2_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_2_TRANSFER_DST_BIT,
                       VMA_MEMORY_USAGE_AUTO_PREFER_DEVICE);
  NVVK_DBG_NAME(m_frameInfoBuffer.buffer);
}

void GaussianSplatting::deinitRendererBuffers()
{
  // TODO can we rather move this to pipelines creation/deletion ?
  if(m_gpuSorter != VK_NULL_HANDLE)
  {
    vrdxDestroySorter(m_gpuSorter);
    m_gpuSorter = VK_NULL_HANDLE;
  }

  m_alloc.destroyBuffer(m_splatDistancesDevice);
  m_alloc.destroyBuffer(m_splatIndicesDevice);
  m_alloc.destroyBuffer(m_splatIndicesHost);
  m_alloc.destroyBuffer(m_vrdxStorageDevice);

  m_alloc.destroyBuffer(m_indirect);
  m_alloc.destroyBuffer(m_indirectReadbackHost);
  m_alloc.destroyBuffer(m_depthReadbackHost);
  m_alloc.destroyBuffer(m_segReadbackHost);
  m_alloc.destroyBuffer(m_rgbReadbackHost);

  m_alloc.destroyBuffer(m_quadVertices);
  m_alloc.destroyBuffer(m_quadIndices);

  m_alloc.destroyBuffer(m_frameInfoBuffer);
}

void GaussianSplatting::benchmarkAdvance()
{
  std::cout << "BENCHMARK_ADV " << m_benchmarkId << " {" << std::endl;
  std::cout << " Memory Scene; Host used \t" << m_splatSetVk.memoryStats.srcAll << "; Device Used \t"
            << m_splatSetVk.memoryStats.odevAll << "; Device Allocated \t" << m_splatSetVk.memoryStats.devAll
            << "; (bytes)" << std::endl;
  std::cout << " Memory Rasterization; Host used \t" << m_renderMemoryStats.rasterHostTotal << "; Device Used \t"
            << m_renderMemoryStats.rasterDeviceUsedTotal << "; Device Allocated \t"
            << m_renderMemoryStats.rasterDeviceAllocTotal << "; (bytes)" << std::endl;
  std::cout << " Memory Raytracing; Host used \t" << m_renderMemoryStats.rtxHostTotal << "; Device Used \t"
            << m_renderMemoryStats.rtxDeviceUsedTotal << "; Device Allocated \t"
            << m_renderMemoryStats.rtxDeviceAllocTotal << "; (bytes)" << std::endl;
  std::cout << "}" << std::endl;

  m_benchmarkId++;
}

/////////////////////////////////////////////
/// RTX

//--------------------------------------------------------------------------------------------------
// This descriptor set holds the Acceleration structure and the output image
//
void GaussianSplatting::initRtDescriptorSet()
{
  //SCOPED_TIMER(__FUNCTION__"\n");

  //////////////////////
  // Bindings

  m_rtDescriptorBindings.clear();

  m_rtDescriptorBindings.addBinding(RTX_BINDING_OUTIMAGE, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1, VK_SHADER_STAGE_RAYGEN_BIT_KHR);
  m_rtDescriptorBindings.addBinding(RTX_BINDING_AUX1, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1, VK_SHADER_STAGE_RAYGEN_BIT_KHR);
  m_rtDescriptorBindings.addBinding(RTX_BINDING_OUTDEPTH, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1, VK_SHADER_STAGE_RAYGEN_BIT_KHR);
  m_rtDescriptorBindings.addBinding(RTX_BINDING_OUTSEG, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1, VK_SHADER_STAGE_RAYGEN_BIT_KHR);

  m_rtDescriptorBindings.addBinding(RTX_BINDING_TLAS_SPLATS, VK_DESCRIPTOR_TYPE_ACCELERATION_STRUCTURE_KHR, 1,
                                    VK_SHADER_STAGE_RAYGEN_BIT_KHR);
  m_rtDescriptorBindings.addBinding(RTX_BINDING_TLAS_MESH, VK_DESCRIPTOR_TYPE_ACCELERATION_STRUCTURE_KHR, 1,
                                    VK_SHADER_STAGE_RAYGEN_BIT_KHR);

  NVVK_CHECK(m_rtDescriptorBindings.createDescriptorSetLayout(m_device, 0, &m_rtDescriptorSetLayout));
  NVVK_DBG_NAME(m_rtDescriptorSetLayout);

  //
  std::vector<VkDescriptorPoolSize> poolSize;
  m_rtDescriptorBindings.appendPoolSizes(poolSize);
  VkDescriptorPoolCreateInfo poolInfo = {
      .sType         = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
      .maxSets       = 1,
      .poolSizeCount = uint32_t(poolSize.size()),
      .pPoolSizes    = poolSize.data(),
  };
  NVVK_CHECK(vkCreateDescriptorPool(m_device, &poolInfo, nullptr, &m_rtDescriptorPool));
  NVVK_DBG_NAME(m_rtDescriptorPool);

  VkDescriptorSetAllocateInfo allocInfo = {
      .sType              = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
      .descriptorPool     = m_rtDescriptorPool,
      .descriptorSetCount = 1,
      .pSetLayouts        = &m_rtDescriptorSetLayout,
  };
  NVVK_CHECK(vkAllocateDescriptorSets(m_device, &allocInfo, &m_rtDescriptorSet));
  NVVK_DBG_NAME(m_rtDescriptorSet);

  //////////////////////
  // Writes

  nvvk::WriteSetContainer writeContainer;

  // Output image buffer
  writeContainer.append(m_rtDescriptorBindings.getWriteSet(RTX_BINDING_OUTIMAGE, m_rtDescriptorSet),
                        m_gBuffers.getColorImageView(COLOR_MAIN), VK_IMAGE_LAYOUT_GENERAL);
  writeContainer.append(m_rtDescriptorBindings.getWriteSet(RTX_BINDING_AUX1, m_rtDescriptorSet),
                        m_gBuffers.getColorImageView(COLOR_AUX1), VK_IMAGE_LAYOUT_GENERAL);
  writeContainer.append(m_rtDescriptorBindings.getWriteSet(RTX_BINDING_OUTDEPTH, m_rtDescriptorSet),
                        m_gBuffers.getDepthImageView(), VK_IMAGE_LAYOUT_GENERAL);
  writeContainer.append(m_rtDescriptorBindings.getWriteSet(RTX_BINDING_OUTSEG, m_rtDescriptorSet),
                        m_gBuffers.getColorImageView(COLOR_SEG), VK_IMAGE_LAYOUT_GENERAL);

  // splats TLAS
  if(m_splatSetVk.rtAccelerationStructures.tlas.accel != NULL)
    writeContainer.append(m_rtDescriptorBindings.getWriteSet(RTX_BINDING_TLAS_SPLATS, m_rtDescriptorSet),
                          m_splatSetVk.rtAccelerationStructures.tlas);
  // mesh TLAS
  if(m_meshSetVk.instances.size() && (m_meshSetVk.rtAccelerationStructures.tlas.accel != NULL))
  {
    writeContainer.append(m_rtDescriptorBindings.getWriteSet(RTX_BINDING_TLAS_MESH, m_rtDescriptorSet),
                          m_meshSetVk.rtAccelerationStructures.tlas);
  }

  // actually write
  vkUpdateDescriptorSets(m_device, static_cast<uint32_t>(writeContainer.size()), writeContainer.data(), 0, nullptr);
}

//--------------------------------------------------------------------------------------------------
// Writes the output image to the descriptor set
// - Required when changing resolution
//
void GaussianSplatting::updateRtDescriptorSet()
{
  //SCOPED_TIMER(__FUNCTION__"\n");

  // update only if the descriptor set is already initialized
  if(m_rtDescriptorSet != VK_NULL_HANDLE)
  {
    nvvk::WriteSetContainer writeContainer;

    // Output image buffer
    writeContainer.append(m_rtDescriptorBindings.getWriteSet(RTX_BINDING_OUTIMAGE, m_rtDescriptorSet),
                          m_gBuffers.getColorImageView(COLOR_MAIN), VK_IMAGE_LAYOUT_GENERAL);
    writeContainer.append(m_rtDescriptorBindings.getWriteSet(RTX_BINDING_AUX1, m_rtDescriptorSet),
                          m_gBuffers.getColorImageView(COLOR_AUX1), VK_IMAGE_LAYOUT_GENERAL);
    writeContainer.append(m_rtDescriptorBindings.getWriteSet(RTX_BINDING_OUTDEPTH, m_rtDescriptorSet),
                          m_gBuffers.getDepthImageView(), VK_IMAGE_LAYOUT_GENERAL);
    writeContainer.append(m_rtDescriptorBindings.getWriteSet(RTX_BINDING_OUTSEG, m_rtDescriptorSet),
                          m_gBuffers.getColorImageView(COLOR_SEG), VK_IMAGE_LAYOUT_GENERAL);
    // let's update
    vkUpdateDescriptorSets(m_device, static_cast<uint32_t>(writeContainer.size()), writeContainer.data(), 0, nullptr);
  }
}

//--------------------------------------------------------------------------------------------------
// Pipeline for the ray tracer: all shaders, raygen, chit, miss
//
void GaussianSplatting::initRtPipeline()
{
  //SCOPED_TIMER(__FUNCTION__"\n");

  enum StageIndices
  {
    eRaygen,
    eMiss,
    eMiss2,
    eClosestHit,
    eAnyHit,
    eIntersection,
    eStageIndicesCount
  };

  // if not using AABBs we do not use the intersection shader (last stage listed)
  uint32_t stagesCount = prmRtxData.useAABBs ? eStageIndicesCount : eStageIndicesCount - 1;

  // All stages
  std::array<VkPipelineShaderStageCreateInfo, eStageIndicesCount> stages{};
  VkPipelineShaderStageCreateInfo stage{VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO};
  stage.pName = "main";  // All the same entry point
  // Raygen
  stage.module    = m_shaders.rtxRgenShader;
  stage.stage     = VK_SHADER_STAGE_RAYGEN_BIT_KHR;
  stages[eRaygen] = stage;
  // Miss
  stage.module  = m_shaders.rtxRmissShader;
  stage.stage   = VK_SHADER_STAGE_MISS_BIT_KHR;
  stages[eMiss] = stage;
  // The second miss shader is invoked when a shadow ray misses the geometry. It simply indicates that no occlusion has been found
  stage.module   = m_shaders.rtxRmiss2Shader;
  stage.stage    = VK_SHADER_STAGE_MISS_BIT_KHR;
  stages[eMiss2] = stage;
  // Hit Group - Closest Hit
  stage.module        = m_shaders.rtxRchitShader;
  stage.stage         = VK_SHADER_STAGE_CLOSEST_HIT_BIT_KHR;
  stages[eClosestHit] = stage;
  // Hit Group - Any Hit
  stage.module    = m_shaders.rtxRahitShader;
  stage.stage     = VK_SHADER_STAGE_ANY_HIT_BIT_KHR;
  stages[eAnyHit] = stage;
  // Hit Group - Intersection (used only if useAABBs is true)
  stage.module          = m_shaders.rtxRintShader;
  stage.stage           = VK_SHADER_STAGE_INTERSECTION_BIT_KHR;
  stages[eIntersection] = stage;

  // Shader groups
  VkRayTracingShaderGroupCreateInfoKHR group{VK_STRUCTURE_TYPE_RAY_TRACING_SHADER_GROUP_CREATE_INFO_KHR};
  group.anyHitShader       = VK_SHADER_UNUSED_KHR;
  group.closestHitShader   = VK_SHADER_UNUSED_KHR;
  group.generalShader      = VK_SHADER_UNUSED_KHR;
  group.intersectionShader = VK_SHADER_UNUSED_KHR;

  // Raygen
  group.type          = VK_RAY_TRACING_SHADER_GROUP_TYPE_GENERAL_KHR;
  group.generalShader = eRaygen;
  m_rtShaderGroups.push_back(group);

  // Miss
  group.type          = VK_RAY_TRACING_SHADER_GROUP_TYPE_GENERAL_KHR;
  group.generalShader = eMiss;
  m_rtShaderGroups.push_back(group);

  // Shadow Miss
  group.type          = VK_RAY_TRACING_SHADER_GROUP_TYPE_GENERAL_KHR;
  group.generalShader = eMiss2;
  m_rtShaderGroups.push_back(group);

  if(prmRtxData.useAABBs)
  {
    // Hit 0 any hit shader with procedural intersections
    group.type               = VK_RAY_TRACING_SHADER_GROUP_TYPE_PROCEDURAL_HIT_GROUP_KHR;
    group.generalShader      = VK_SHADER_UNUSED_KHR;
    group.closestHitShader   = VK_SHADER_UNUSED_KHR;
    group.anyHitShader       = eAnyHit;
    group.intersectionShader = eIntersection;
    m_rtShaderGroups.push_back(group);
  }
  else
  {
    // Hit 0 any hit shader with mesh ICOSA
    group.type               = VK_RAY_TRACING_SHADER_GROUP_TYPE_TRIANGLES_HIT_GROUP_KHR;
    group.generalShader      = VK_SHADER_UNUSED_KHR;
    group.closestHitShader   = VK_SHADER_UNUSED_KHR;
    group.intersectionShader = VK_SHADER_UNUSED_KHR;
    group.anyHitShader       = eAnyHit;
    m_rtShaderGroups.push_back(group);
  }

  // Hit 1 Closest-hit only (for eMeshTlas)
  group.type               = VK_RAY_TRACING_SHADER_GROUP_TYPE_TRIANGLES_HIT_GROUP_KHR;
  group.generalShader      = VK_SHADER_UNUSED_KHR;
  group.anyHitShader       = VK_SHADER_UNUSED_KHR;
  group.intersectionShader = VK_SHADER_UNUSED_KHR;
  group.closestHitShader   = eClosestHit;
  m_rtShaderGroups.push_back(group);

  // Push constant: we want to be able to update constants used by the shaders
  VkPushConstantRange pushConstant{VK_SHADER_STAGE_RAYGEN_BIT_KHR | VK_SHADER_STAGE_CLOSEST_HIT_BIT_KHR | VK_SHADER_STAGE_ANY_HIT_BIT_KHR
                                       | VK_SHADER_STAGE_MISS_BIT_KHR | VK_SHADER_STAGE_INTERSECTION_BIT_KHR,
                                   0, sizeof(shaderio::PushConstantRay)};


  VkPipelineLayoutCreateInfo pipelineLayoutCreateInfo{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
  pipelineLayoutCreateInfo.pushConstantRangeCount = 1;
  pipelineLayoutCreateInfo.pPushConstantRanges    = &pushConstant;

  // Descriptor sets: one specific to ray tracing, and one shared with the rasterization pipeline
  std::vector<VkDescriptorSetLayout> rtDescSetLayouts = {m_descriptorSetLayout, m_rtDescriptorSetLayout};
  pipelineLayoutCreateInfo.setLayoutCount             = static_cast<uint32_t>(rtDescSetLayouts.size());
  pipelineLayoutCreateInfo.pSetLayouts                = rtDescSetLayouts.data();

  vkCreatePipelineLayout(m_device, &pipelineLayoutCreateInfo, nullptr, &m_rtPipelineLayout);

  // Assemble the shader stages and recursion depth info into the ray tracing pipeline
  VkRayTracingPipelineCreateInfoKHR rayPipelineInfo{VK_STRUCTURE_TYPE_RAY_TRACING_PIPELINE_CREATE_INFO_KHR};
  rayPipelineInfo.stageCount = stagesCount;  // Stages are shaders
  rayPipelineInfo.pStages    = stages.data();

  // In this case, m_rtShaderGroups.size() == 4: we have one raygen group,
  // two miss shader groups, and one hit group.
  rayPipelineInfo.groupCount = static_cast<uint32_t>(m_rtShaderGroups.size());
  rayPipelineInfo.pGroups    = m_rtShaderGroups.data();

  // The ray tracing process can shoot rays from the camera, and a shadow ray can be shot from the
  // hit points of the camera rays, hence a recursion level of 2. This number should be kept as low
  // as possible for performance reasons. Even recursive ray tracing should be flattened into a loop
  // in the ray generation to avoid deep recursion.
  rayPipelineInfo.maxPipelineRayRecursionDepth = 2;  // Ray depth
  rayPipelineInfo.layout                       = m_rtPipelineLayout;

  vkCreateRayTracingPipelinesKHR(m_device, {}, {}, 1, &rayPipelineInfo, nullptr, &m_rtPipeline);


  // Spec only guarantees 1 level of "recursion". Check for that sad possibility here.
  if(m_rtProperties.maxRayRecursionDepth <= 1)
  {
    throw std::runtime_error("Device fails to support ray recursion (m_rtProperties.maxRayRecursionDepth <= 1)");
  }

  // Creating the SBT
  {
    // Shader Binding Table (SBT) setup
    nvvk::SBTGenerator sbtGenerator;
    sbtGenerator.init(m_app->getDevice(), m_rtProperties);

    // Prepare SBT data from ray pipeline
    size_t bufferSize = sbtGenerator.calculateSBTBufferSize(m_rtPipeline, rayPipelineInfo);

    // Create SBT buffer using the size from above
    NVVK_CHECK(m_alloc.createBuffer(m_rtSBTBuffer, bufferSize, VK_BUFFER_USAGE_2_SHADER_BINDING_TABLE_BIT_KHR, VMA_MEMORY_USAGE_AUTO_PREFER_DEVICE,
                                    VMA_ALLOCATION_CREATE_MAPPED_BIT | VMA_ALLOCATION_CREATE_HOST_ACCESS_RANDOM_BIT,
                                    sbtGenerator.getBufferAlignment()));
    NVVK_DBG_NAME(m_rtSBTBuffer.buffer);

    // Pass the manual mapped pointer to fill the sbt data
    NVVK_CHECK(sbtGenerator.populateSBTBuffer(m_rtSBTBuffer.address, bufferSize, m_rtSBTBuffer.mapping));

    // Retrieve the regions, which are using addresses based on the m_sbtBuffer.address
    m_sbtRegions = sbtGenerator.getSBTRegions();

    sbtGenerator.deinit();
  }
}

//--------------------------------------------------------------------------------------------------
// Ray Tracing the scene
//
void GaussianSplatting::raytrace(const VkCommandBuffer& cmdBuf, bool meshDepthOnly)
{
  NVVK_DBG_SCOPE(cmdBuf);

  const std::string name = meshDepthOnly ? "Raytracing prepass" : "Raytracing";

  auto timerSection = m_profilerGpuTimer.cmdFrameSection(cmdBuf, name);

  // Initializing push constant values
  m_pcRay.modelMatrix        = m_splatSetVk.transform;
  m_pcRay.modelMatrixInverse = m_splatSetVk.transformInverse;
  // cast to mat3 extracts only the rot/scale part of the transform
  m_pcRay.modelMatrixRotScaleInverse = glm::inverse(glm::mat3(m_splatSetVk.transform));
  m_pcRay.meshDepthOnly              = meshDepthOnly;

  std::vector<VkDescriptorSet> descSets{m_descriptorSet, m_rtDescriptorSet};
  vkCmdBindPipeline(cmdBuf, VK_PIPELINE_BIND_POINT_RAY_TRACING_KHR, m_rtPipeline);
  vkCmdBindDescriptorSets(cmdBuf, VK_PIPELINE_BIND_POINT_RAY_TRACING_KHR, m_rtPipelineLayout, 0,
                          (uint32_t)descSets.size(), descSets.data(), 0, nullptr);

  m_pcRay.vertexAddress = m_splatSetVk.m_splatModel.vertexBuffer.address;
  m_pcRay.indexAddress  = m_splatSetVk.m_splatModel.indexBuffer.address;

  vkCmdPushConstants(cmdBuf, m_rtPipelineLayout,
                     VK_SHADER_STAGE_RAYGEN_BIT_KHR | VK_SHADER_STAGE_CLOSEST_HIT_BIT_KHR | VK_SHADER_STAGE_ANY_HIT_BIT_KHR
                         | VK_SHADER_STAGE_MISS_BIT_KHR | VK_SHADER_STAGE_INTERSECTION_BIT_KHR,
                     0, sizeof(shaderio::PushConstantRay), &m_pcRay);


  vkCmdTraceRaysKHR(cmdBuf, &m_sbtRegions.raygen, &m_sbtRegions.miss, &m_sbtRegions.hit, &m_sbtRegions.callable,
                    uint32_t(m_viewSize[0]), uint32_t(m_viewSize[1]), 1);
}


bool GaussianSplatting::updateFrameCounter()
{
  static float     ref_fov{0};
  static glm::mat4 ref_cam_matrix;

  const auto& m   = cameraManip->getViewMatrix();
  const auto  fov = cameraManip->getFov();

  if(ref_cam_matrix != m || ref_fov != fov)
  {
    resetFrameCounter();
    ref_cam_matrix = m;
    ref_fov        = fov;
  }

  if(prmFrame.frameSampleId >= prmFrame.frameSampleMax)
  {
    return false;
  }
  prmFrame.frameSampleId++;
  return true;
}

///////////////////////////////////
// Post processings

void GaussianSplatting::initDescriptorSetPostProcessing()
{
  // Descriptor Bindings
  m_descriptorBindingsPostProcess.clear();
  m_descriptorBindingsPostProcess.addBinding(BINDING_FRAME_INFO_UBO, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT);
  m_descriptorBindingsPostProcess.addBinding(POST_BINDING_MAIN_IMAGE, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1, VK_SHADER_STAGE_COMPUTE_BIT);
  m_descriptorBindingsPostProcess.addBinding(POST_BINDING_AUX1_IMAGE, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1, VK_SHADER_STAGE_COMPUTE_BIT);
  NVVK_CHECK(m_descriptorBindingsPostProcess.createDescriptorSetLayout(m_device, 0, &m_descriptorSetLayoutPostProcess));
  NVVK_DBG_NAME(m_descriptorSetLayoutPostProcess);

  // Descriptor Pool
  std::vector<VkDescriptorPoolSize> poolSize;
  m_descriptorBindingsPostProcess.appendPoolSizes(poolSize);
  VkDescriptorPoolCreateInfo poolInfo = {
      .sType         = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
      .maxSets       = 1,
      .poolSizeCount = uint32_t(poolSize.size()),
      .pPoolSizes    = poolSize.data(),
  };
  NVVK_CHECK(vkCreateDescriptorPool(m_device, &poolInfo, nullptr, &m_descriptorPoolPostProcess));
  NVVK_DBG_NAME(m_descriptorPoolPostProcess);

  // Descriptor Set
  VkDescriptorSetAllocateInfo allocInfo = {
      .sType              = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
      .descriptorPool     = m_descriptorPoolPostProcess,
      .descriptorSetCount = 1,
      .pSetLayouts        = &m_descriptorSetLayoutPostProcess,
  };
  NVVK_CHECK(vkAllocateDescriptorSets(m_device, &allocInfo, &m_descriptorSetPostProcess));
  NVVK_DBG_NAME(m_descriptorSetPostProcess);

  // Pipelne layout
  const VkPushConstantRange pcRanges = {VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT
                                            | VK_SHADER_STAGE_MESH_BIT_EXT | VK_SHADER_STAGE_COMPUTE_BIT,
                                        0, sizeof(shaderio::PushConstant)};

  VkPipelineLayoutCreateInfo plCreateInfo{
      .sType                  = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
      .setLayoutCount         = 1,
      .pSetLayouts            = &m_descriptorSetLayoutPostProcess,
      .pushConstantRangeCount = 1,
      .pPushConstantRanges    = &pcRanges,
  };
  NVVK_CHECK(vkCreatePipelineLayout(m_device, &plCreateInfo, nullptr, &m_pipelineLayoutPostProcess));
  NVVK_DBG_NAME(m_pipelineLayoutPostProcess);

  // Writes
  nvvk::WriteSetContainer writeContainer;
  writeContainer.append(m_descriptorBindingsPostProcess.getWriteSet(BINDING_FRAME_INFO_UBO, m_descriptorSetPostProcess),
                        m_frameInfoBuffer);
  writeContainer.append(m_descriptorBindingsPostProcess.getWriteSet(POST_BINDING_MAIN_IMAGE, m_descriptorSetPostProcess),
                        m_gBuffers.getColorImageView(COLOR_MAIN), VK_IMAGE_LAYOUT_GENERAL);
  writeContainer.append(m_descriptorBindingsPostProcess.getWriteSet(POST_BINDING_AUX1_IMAGE, m_descriptorSetPostProcess),
                        m_gBuffers.getColorImageView(COLOR_AUX1), VK_IMAGE_LAYOUT_GENERAL);
  vkUpdateDescriptorSets(m_device, static_cast<uint32_t>(writeContainer.size()), writeContainer.data(), 0, nullptr);
}

void GaussianSplatting::updateDescriptorSetPostProcessing()
{
  // update only if the descriptor set is already initialized
  if(m_descriptorSetPostProcess != VK_NULL_HANDLE)
  {
    nvvk::WriteSetContainer writeContainer;
    writeContainer.append(m_descriptorBindingsPostProcess.getWriteSet(POST_BINDING_MAIN_IMAGE, m_descriptorSetPostProcess),
                          m_gBuffers.getColorImageView(COLOR_MAIN), VK_IMAGE_LAYOUT_GENERAL);
    writeContainer.append(m_descriptorBindingsPostProcess.getWriteSet(POST_BINDING_AUX1_IMAGE, m_descriptorSetPostProcess),
                          m_gBuffers.getColorImageView(COLOR_AUX1), VK_IMAGE_LAYOUT_GENERAL);
    vkUpdateDescriptorSets(m_device, static_cast<uint32_t>(writeContainer.size()), writeContainer.data(), 0, nullptr);
  }
}

void GaussianSplatting::initPipelinePostProcessing()
{

  VkComputePipelineCreateInfo pipelineInfo{
      .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
      .stage =
          {
              .sType  = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
              .stage  = VK_SHADER_STAGE_COMPUTE_BIT,
              .module = m_shaders.postComputeShader,
              .pName  = "main",
          },
      .layout = m_pipelineLayoutPostProcess,
  };
  vkCreateComputePipelines(m_device, {}, 1, &pipelineInfo, nullptr, &m_computePipelinePostProcess);
  NVVK_DBG_NAME(m_computePipelinePostProcess);
}

void GaussianSplatting::postProcess(VkCommandBuffer cmd)
{
  NVVK_DBG_SCOPE(cmd);

  auto timerSection = m_profilerGpuTimer.cmdFrameSection(cmd, "Post process");

  vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, m_computePipelinePostProcess);
  vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, m_pipelineLayoutPostProcess, 0, 1,
                          &m_descriptorSetPostProcess, 0, nullptr);

  uint32_t wgSize = 32;

  vkCmdDispatch(cmd, (uint32_t(m_viewSize.x) + wgSize - 1) / wgSize, (uint32_t(m_viewSize.y) + wgSize - 1) / wgSize, 1);
}

}  // namespace vk_gaussian_splatting