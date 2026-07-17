/*
 * Copyright (c) 2023-2025, NVIDIA CORPORATION.  All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#define STB_IMAGE_IMPLEMENTATION
#define STBI_WINDOWS_UTF8
#include <stb/stb_image.h>

#include "export_preview.h"
#include "gaussian_splatting.h"

#include <algorithm>
#include <backends/imgui_impl_vulkan.h>
#include <fmt/format.h>

#include <nvutils/file_operations.hpp>
#include <nvvk/check_error.hpp>
#include <nvvk/default_structs.hpp>

namespace vk_gaussian_splatting {

namespace {

ImVec2 fitImageSize(float imageW, float imageH, ImVec2 avail)
{
  if(imageW <= 0.0F || imageH <= 0.0F || avail.x <= 0.0F || avail.y <= 0.0F)
    return ImVec2(0.0F, 0.0F);
  const float scale = std::min(avail.x / imageW, avail.y / imageH);
  return ImVec2(imageW * scale, imageH * scale);
}

const char* multiViewImageLabel(ExportPreviewPanel::MultiViewImage image)
{
  switch(image)
  {
    case ExportPreviewPanel::MultiViewImage::Rgb:
      return "rgb";
    case ExportPreviewPanel::MultiViewImage::Depth:
      return "depth";
    case ExportPreviewPanel::MultiViewImage::Seg:
      return "seg";
    default:
      return "rgb";
  }
}

const char* multiViewImageFilename(ExportPreviewPanel::MultiViewImage image)
{
  switch(image)
  {
    case ExportPreviewPanel::MultiViewImage::Rgb:
      return "rgb.png";
    case ExportPreviewPanel::MultiViewImage::Depth:
      return "depth.png";
    case ExportPreviewPanel::MultiViewImage::Seg:
      return "seg.png";
    default:
      return "rgb.png";
  }
}

}  // namespace

void ExportPreviewPanel::PreviewTexture::destroy(VkDevice device, nvvk::ResourceAllocator* alloc)
{
  if(imguiTexture != VK_NULL_HANDLE)
  {
    ImGui_ImplVulkan_RemoveTexture(imguiTexture);
    imguiTexture = VK_NULL_HANDLE;
  }
  if(image.image != VK_NULL_HANDLE && alloc != nullptr)
  {
    alloc->destroyImage(image);
    image = {};
  }
  width = height = 0;
  loadedPath.clear();
}

bool ExportPreviewPanel::PreviewTexture::loadFromPng(const std::filesystem::path& path,
                                                     VkDevice                       device,
                                                     nvvk::ResourceAllocator*       alloc,
                                                     nvvk::StagingUploader*         uploader,
                                                     nvapp::Application*            app,
                                                     VkSampler                      sampler)
{
  if(path.empty() || !std::filesystem::exists(path))
    return false;

  if(loadedPath == path && imguiTexture != VK_NULL_HANDLE)
    return true;

  destroy(device, alloc);

  const std::string pathUtf8 = nvutils::utf8FromPath(path);
  int               comp     = 0;
  stbi_uc*          pixels   = stbi_load(pathUtf8.c_str(), &width, &height, &comp, 4);
  if(pixels == nullptr || width <= 0 || height <= 0)
  {
    if(pixels != nullptr)
      stbi_image_free(pixels);
    return false;
  }

  VkImageCreateInfo imageInfo = DEFAULT_VkImageCreateInfo;
  imageInfo.extent            = {uint32_t(width), uint32_t(height), 1};
  imageInfo.format            = VK_FORMAT_R8G8B8A8_UNORM;
  imageInfo.usage             = VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_SAMPLED_BIT;

  if(alloc->createImage(image, imageInfo, DEFAULT_VkImageViewCreateInfo) != VK_SUCCESS)
  {
    stbi_image_free(pixels);
    destroy(device, alloc);
    return false;
  }

  image.descriptor.imageLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;

  VkCommandBuffer cmd = app->createTempCmdBuffer();
  NVVK_CHECK(uploader->appendImage(image, size_t(width) * size_t(height) * 4, pixels, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL));
  uploader->cmdUploadAppended(cmd);
  app->submitAndWaitTempCmdBuffer(cmd);
  stbi_image_free(pixels);

  imguiTexture = ImGui_ImplVulkan_AddTexture(sampler, image.descriptor.imageView, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL);
  loadedPath   = path;
  return imguiTexture != VK_NULL_HANDLE;
}

void ExportPreviewPanel::init(nvapp::Application* app, nvvk::ResourceAllocator* alloc, nvvk::StagingUploader* uploader, VkSampler sampler)
{
  m_app      = app;
  m_alloc    = alloc;
  m_uploader = uploader;
  m_sampler  = sampler;
  m_device   = app->getDevice();
}

void ExportPreviewPanel::deinit()
{
  m_texture.destroy(m_device, m_alloc);
  m_app      = nullptr;
  m_alloc    = nullptr;
  m_uploader = nullptr;
  m_sampler  = VK_NULL_HANDLE;
  m_device   = VK_NULL_HANDLE;
}

void ExportPreviewPanel::notifyExport(ExportPreviewNotify kind)
{
  m_needsHistoryRefresh = true;
  switch(kind)
  {
    case ExportPreviewNotify::Depth:
      m_activeTab        = PreviewTab::Depth;
      m_selectedDepthIdx = -1;
      break;
    case ExportPreviewNotify::Seg:
      m_activeTab      = PreviewTab::Seg;
      m_selectedSegIdx = -1;
      break;
    case ExportPreviewNotify::MultiView:
      m_activeTab         = PreviewTab::MultiView;
      m_multiViewImage    = MultiViewImage::Rgb;
      m_selectedViewIdx   = 0;
      break;
    default:
      break;
  }
}

void ExportPreviewPanel::setLastMultiViewSession(std::filesystem::path sessionDir)
{
  if(sessionDir.empty())
    return;
  m_lastMultiViewSession  = std::move(sessionDir);
  m_needsHistoryRefresh   = true;
}

std::vector<std::filesystem::path> ExportPreviewPanel::listPngsSorted(const std::filesystem::path& directory)
{
  std::vector<std::filesystem::path> files;
  if(!std::filesystem::exists(directory))
    return files;

  std::error_code ec;
  for(const auto& entry : std::filesystem::directory_iterator(directory, ec))
  {
    if(!entry.is_regular_file())
      continue;
    if(entry.path().extension() == ".png")
      files.push_back(entry.path());
  }

  std::sort(files.begin(), files.end(), [](const std::filesystem::path& a, const std::filesystem::path& b) {
    std::error_code ecA;
    std::error_code ecB;
    const auto      timeA = std::filesystem::last_write_time(a, ecA);
    const auto      timeB = std::filesystem::last_write_time(b, ecB);
    if(ecA || ecB)
      return a.filename().string() < b.filename().string();
    return timeA < timeB;
  });
  return files;
}

std::filesystem::path ExportPreviewPanel::latestSubdirectory(const std::filesystem::path& directory)
{
  if(!std::filesystem::exists(directory))
    return {};

  std::filesystem::path               latest;
  std::filesystem::file_time_type     latestTime{};
  bool                                found = false;
  std::error_code                     ec;
  for(const auto& entry : std::filesystem::directory_iterator(directory, ec))
  {
    if(!entry.is_directory())
      continue;
    const auto writeTime = entry.last_write_time(ec);
    if(ec)
      continue;
    if(!found || writeTime > latestTime)
    {
      found      = true;
      latestTime = writeTime;
      latest     = entry.path();
    }
  }
  return latest;
}

std::vector<std::filesystem::path> ExportPreviewPanel::listViewDirs(const std::filesystem::path& sessionDir)
{
  std::vector<std::filesystem::path> views;
  if(!std::filesystem::exists(sessionDir))
    return views;

  std::error_code ec;
  for(const auto& entry : std::filesystem::directory_iterator(sessionDir, ec))
  {
    if(!entry.is_directory())
      continue;
    const auto name = entry.path().filename().string();
    if(name.rfind("view_", 0) == 0)
      views.push_back(entry.path());
  }

  std::sort(views.begin(), views.end());
  return views;
}

void ExportPreviewPanel::scanDepthHistory()
{
  m_depthHistory = listPngsSorted(m_depthOutputDirCache);
  if(m_depthHistory.empty())
    m_selectedDepthIdx = -1;
  else if(m_selectedDepthIdx < 0 || m_selectedDepthIdx >= int(m_depthHistory.size()))
    m_selectedDepthIdx = int(m_depthHistory.size()) - 1;
}

void ExportPreviewPanel::scanSegHistory()
{
  m_segHistory = listPngsSorted(m_segOutputDirCache);
  if(m_segHistory.empty())
    m_selectedSegIdx = -1;
  else if(m_selectedSegIdx < 0 || m_selectedSegIdx >= int(m_segHistory.size()))
    m_selectedSegIdx = int(m_segHistory.size()) - 1;
}

void ExportPreviewPanel::scanMultiViewSession()
{
  if(m_lastMultiViewSession.empty() || !std::filesystem::exists(m_lastMultiViewSession))
    m_multiViewDirs.clear();
  else
    m_multiViewDirs = listViewDirs(m_lastMultiViewSession);

  if(m_multiViewDirs.empty())
    m_selectedViewIdx = 0;
  else
    m_selectedViewIdx = std::clamp(m_selectedViewIdx, 0, int(m_multiViewDirs.size()) - 1);
}

void ExportPreviewPanel::refreshHistoryIfNeeded()
{
  if(!m_needsHistoryRefresh)
    return;
  m_needsHistoryRefresh = false;
  scanDepthHistory();
  scanSegHistory();
  scanMultiViewSession();
  m_needsTextureReload = true;
}

std::filesystem::path ExportPreviewPanel::currentDisplayPath() const
{
  switch(m_activeTab)
  {
    case PreviewTab::Depth:
      if(m_selectedDepthIdx >= 0 && m_selectedDepthIdx < int(m_depthHistory.size()))
        return m_depthHistory[size_t(m_selectedDepthIdx)];
      break;
    case PreviewTab::Seg:
      if(m_selectedSegIdx >= 0 && m_selectedSegIdx < int(m_segHistory.size()))
        return m_segHistory[size_t(m_selectedSegIdx)];
      break;
    case PreviewTab::MultiView:
      if(m_selectedViewIdx >= 0 && m_selectedViewIdx < int(m_multiViewDirs.size()))
      {
        return m_multiViewDirs[size_t(m_selectedViewIdx)] / multiViewImageFilename(m_multiViewImage);
      }
      break;
    default:
      break;
  }
  return {};
}

void ExportPreviewPanel::updateDisplayedTexture()
{
  const std::filesystem::path path = currentDisplayPath();
  if(path.empty())
  {
    m_texture.destroy(m_device, m_alloc);
    return;
  }

  if(!m_needsTextureReload && m_texture.loadedPath == path)
    return;

  m_needsTextureReload = false;
  if(!m_texture.loadFromPng(path, m_device, m_alloc, m_uploader, m_app, m_sampler))
    m_texture.destroy(m_device, m_alloc);
}

void ExportPreviewPanel::draw(const std::filesystem::path& depthOutputDir,
                              const std::filesystem::path& segOutputDir,
                              const std::filesystem::path& multiViewOutputDir,
                              bool                         multiViewActive,
                              const std::string&           multiViewStatus,
                              bool*                        pOpen)
{
  m_depthOutputDirCache     = depthOutputDir;
  m_segOutputDirCache       = segOutputDir;
  m_multiViewOutputDirCache = multiViewOutputDir;

  if(m_lastMultiViewSession.empty())
    m_lastMultiViewSession = latestSubdirectory(multiViewOutputDir);

  refreshHistoryIfNeeded();

  if(ImGui::Begin("Export Preview", pOpen))
  {
    if(ImGui::Button("Refresh"))
      m_needsHistoryRefresh = true;

    ImGui::SameLine();
    if(ImGui::BeginTabBar("ExportPreviewTabs"))
    {
      if(ImGui::BeginTabItem("Depth"))
      {
        m_activeTab          = PreviewTab::Depth;
        m_needsTextureReload = true;
        ImGui::EndTabItem();
      }
      if(ImGui::BeginTabItem("Seg"))
      {
        m_activeTab          = PreviewTab::Seg;
        m_needsTextureReload = true;
        ImGui::EndTabItem();
      }
      if(ImGui::BeginTabItem("Multi-View"))
      {
        m_activeTab          = PreviewTab::MultiView;
        m_needsTextureReload = true;
        ImGui::EndTabItem();
      }
      ImGui::EndTabBar();
    }

    ImGui::Separator();

    if(m_activeTab == PreviewTab::Depth)
    {
      if(m_depthHistory.empty())
      {
        ImGui::TextUnformatted("No depth exports yet. Use Export Depth PNG in Properties.");
      }
      else
      {
        const int idx = std::clamp(m_selectedDepthIdx, 0, int(m_depthHistory.size()) - 1);
        ImGui::SetNextItemWidth(280.0F);
        if(ImGui::BeginCombo("Export##Depth", m_depthHistory[size_t(idx)].filename().string().c_str()))
        {
          for(int i = 0; i < int(m_depthHistory.size()); ++i)
          {
            const bool selected = (i == m_selectedDepthIdx);
            const auto label    = fmt::format("{}: {}", i + 1, m_depthHistory[size_t(i)].filename().string());
            if(ImGui::Selectable(label.c_str(), selected))
            {
              m_selectedDepthIdx   = i;
              m_needsTextureReload = true;
            }
            if(selected)
              ImGui::SetItemDefaultFocus();
          }
          ImGui::EndCombo();
        }
      }
    }
    else if(m_activeTab == PreviewTab::Seg)
    {
      if(m_segHistory.empty())
      {
        ImGui::TextUnformatted("No segmentation exports yet. Use Export Seg PNG in Properties.");
      }
      else
      {
        const int idx = std::clamp(m_selectedSegIdx, 0, int(m_segHistory.size()) - 1);
        ImGui::SetNextItemWidth(280.0F);
        if(ImGui::BeginCombo("Export##Seg", m_segHistory[size_t(idx)].filename().string().c_str()))
        {
          for(int i = 0; i < int(m_segHistory.size()); ++i)
          {
            const bool selected = (i == m_selectedSegIdx);
            const auto label    = fmt::format("{}: {}", i + 1, m_segHistory[size_t(i)].filename().string());
            if(ImGui::Selectable(label.c_str(), selected))
            {
              m_selectedSegIdx     = i;
              m_needsTextureReload = true;
            }
            if(selected)
              ImGui::SetItemDefaultFocus();
          }
          ImGui::EndCombo();
        }
      }
    }
    else
    {
      if(multiViewActive)
      {
        ImGui::TextUnformatted(multiViewStatus.c_str());
      }
      else if(m_multiViewDirs.empty())
      {
        ImGui::TextUnformatted("No multi-view session yet. Use Export Multi-View in Properties.");
      }
      else
      {
        ImGui::SetNextItemWidth(160.0F);
        if(ImGui::BeginCombo("View##MultiView", m_multiViewDirs[size_t(m_selectedViewIdx)].filename().string().c_str()))
        {
          for(int i = 0; i < int(m_multiViewDirs.size()); ++i)
          {
            const bool selected = (i == m_selectedViewIdx);
            const auto label    = m_multiViewDirs[size_t(i)].filename().string();
            if(ImGui::Selectable(label.c_str(), selected))
            {
              m_selectedViewIdx    = i;
              m_needsTextureReload = true;
            }
            if(selected)
              ImGui::SetItemDefaultFocus();
          }
          ImGui::EndCombo();
        }

        ImGui::SameLine();
        ImGui::SetNextItemWidth(100.0F);
        const char* currentImage = multiViewImageLabel(m_multiViewImage);
        if(ImGui::BeginCombo("Image##MultiView", currentImage))
        {
          for(const MultiViewImage image : {MultiViewImage::Rgb, MultiViewImage::Depth, MultiViewImage::Seg})
          {
            const bool selected = (image == m_multiViewImage);
            if(ImGui::Selectable(multiViewImageLabel(image), selected))
            {
              m_multiViewImage     = image;
              m_needsTextureReload = true;
            }
            if(selected)
              ImGui::SetItemDefaultFocus();
          }
          ImGui::EndCombo();
        }

        if(!m_lastMultiViewSession.empty())
          ImGui::Text("Session: %s", m_lastMultiViewSession.filename().string().c_str());
      }
    }

    ImGui::Separator();

    if(!(m_activeTab == PreviewTab::MultiView && multiViewActive))
    {
      updateDisplayedTexture();

      const std::filesystem::path displayPath = currentDisplayPath();
      if(displayPath.empty())
      {
        ImGui::TextUnformatted("No image to display.");
      }
      else if(m_texture.imguiTexture == VK_NULL_HANDLE)
      {
        ImGui::TextUnformatted("Failed to load image.");
        ImGui::Text("%s", displayPath.string().c_str());
      }
      else
      {
        const ImVec2 avail    = ImGui::GetContentRegionAvail();
        const ImVec2 drawSize = fitImageSize(float(m_texture.width), float(m_texture.height), avail);
        ImGui::Image((ImTextureID)m_texture.imguiTexture, drawSize);
        ImGui::Text("%s", displayPath.filename().string().c_str());
      }
    }
  }
  ImGui::End();
}

}  // namespace vk_gaussian_splatting
