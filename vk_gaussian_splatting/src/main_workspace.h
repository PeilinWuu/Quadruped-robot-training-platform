#pragma once

#include <imgui/imgui.h>
#include <functional>
#include <chrono>
#include <string>

#include "app_actions.h"
#include "application_state.h"

namespace vk_gaussian_splatting {

void buildMonitoringDockLayout(ImGuiID dockspaceId);

struct WorkspaceCallbacks
{
  std::function<void(ControlMode)>     requestControlMode;
  std::function<void(TrainingCommand)> requestTrainingCommand;
  std::function<void()>                resetMockTraining;
};

class MainWorkspace
{
public:
  void init(ApplicationState* state, WorkspaceCallbacks callbacks = {});
  void deinit();
  void update(std::chrono::steady_clock::time_point now);
  void draw();
  void addLog(LogSeverity severity, std::string category, std::string message);

private:
  void drawProjectStatus();
  void drawSceneAndEnvironment();
  void drawRobotAndSensors();
  void drawTrainingMonitor();
  void drawTrainingCharts();
  void drawPerformanceCharts();
  void drawNavigationMap();
  void drawEventLog();
  void drawStatusBar();

  ApplicationState* m_state{nullptr};
  WorkspaceCallbacks m_callbacks;
  std::chrono::steady_clock::time_point m_started{};
  std::chrono::steady_clock::time_point m_nextTrainingSample{};
  std::chrono::steady_clock::time_point m_nextPerformanceSample{};
  std::chrono::steady_clock::time_point m_nextNavigationSample{};
  TrainingRunState                      m_lastTrainingState{TrainingRunState::Idle};
};

}  // namespace vk_gaussian_splatting
