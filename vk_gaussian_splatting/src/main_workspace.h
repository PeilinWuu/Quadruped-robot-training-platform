#pragma once

#include <imgui/imgui.h>
#include <functional>

#include "app_actions.h"

namespace vk_gaussian_splatting {

struct ApplicationState;

void buildMonitoringDockLayout(ImGuiID dockspaceId);

struct WorkspaceCallbacks
{
  std::function<void(ControlMode)>     requestControlMode;
  std::function<void(TrainingCommand)> requestTrainingCommand;
};

class MainWorkspace
{
public:
  void init(ApplicationState* state, WorkspaceCallbacks callbacks = {});
  void deinit();
  void draw();

private:
  void drawProjectStatus();
  void drawSceneAndEnvironment();
  void drawRobotAndSensors();
  void drawTrainingMonitor();
  void drawStatusBar();

  ApplicationState* m_state{nullptr};
  WorkspaceCallbacks m_callbacks;
};

}  // namespace vk_gaussian_splatting
