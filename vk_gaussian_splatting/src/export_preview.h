/*
 * Copyright (c) 2023-2025, NVIDIA CORPORATION.  All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef _EXPORT_PREVIEW_H_
#define _EXPORT_PREVIEW_H_

#include <filesystem>
#include <vector>

#include <imgui/imgui.h>
#include <vulkan/vulkan_core.h>

#include <nvapp/application.hpp>
#include <nvvk/resource_allocator.hpp>
#include <nvvk/staging.hpp>

namespace vk_gaussian_splatting {

enum class ExportPreviewNotify;

class ExportPreviewPanel
{
public:
  enum class PreviewTab
  {
    Depth,
    Seg,
    MultiView
  };

  enum class MultiViewImage
  {
    Rgb,
    Depth,
    Seg
  };

  void init(nvapp::Application* app, nvvk::ResourceAllocator* alloc, nvvk::StagingUploader* uploader, VkSampler sampler);
  void deinit();

  void notifyExport(ExportPreviewNotify kind);
  void setLastMultiViewSession(std::filesystem::path sessionDir);

  void draw(const std::filesystem::path& depthOutputDir,
            const std::filesystem::path& segOutputDir,
            const std::filesystem::path& multiViewOutputDir,
            bool                         multiViewActive,
            const std::string&           multiViewStatus,
            bool*                        pOpen);

private:
  struct PreviewTexture
  {
    nvvk::Image       image{};
    VkDescriptorSet   imguiTexture = VK_NULL_HANDLE;
    int               width        = 0;
    int               height       = 0;
    std::filesystem::path loadedPath;

    void destroy(VkDevice device, nvvk::ResourceAllocator* alloc);
    bool loadFromPng(const std::filesystem::path&           path,
                     VkDevice                               device,
                     nvvk::ResourceAllocator*               alloc,
                     nvvk::StagingUploader*                 uploader,
                     nvapp::Application*                    app,
                     VkSampler                              sampler);
  };

  void refreshHistoryIfNeeded();
  void scanDepthHistory();
  void scanSegHistory();
  void scanMultiViewSession();
  void updateDisplayedTexture();
  std::filesystem::path currentDisplayPath() const;

  static std::vector<std::filesystem::path> listPngsSorted(const std::filesystem::path& directory);
  static std::vector<std::filesystem::path> listViewDirs(const std::filesystem::path& sessionDir);
  static std::filesystem::path              latestSubdirectory(const std::filesystem::path& directory);

  nvapp::Application*     m_app      = nullptr;
  nvvk::ResourceAllocator* m_alloc    = nullptr;
  nvvk::StagingUploader*  m_uploader = nullptr;
  VkSampler               m_sampler  = VK_NULL_HANDLE;
  VkDevice                m_device     = VK_NULL_HANDLE;

  PreviewTab  m_activeTab       = PreviewTab::Depth;
  MultiViewImage m_multiViewImage = MultiViewImage::Rgb;

  std::vector<std::filesystem::path> m_depthHistory;
  std::vector<std::filesystem::path> m_segHistory;
  std::filesystem::path              m_lastMultiViewSession;
  std::vector<std::filesystem::path> m_multiViewDirs;

  int m_selectedDepthIdx = -1;
  int m_selectedSegIdx   = -1;
  int m_selectedViewIdx  = 0;

  PreviewTexture m_texture;
  bool           m_needsHistoryRefresh = true;
  bool           m_needsTextureReload  = true;

  std::filesystem::path m_depthOutputDirCache;
  std::filesystem::path m_segOutputDirCache;
  std::filesystem::path m_multiViewOutputDirCache;
};

}  // namespace vk_gaussian_splatting

#endif
