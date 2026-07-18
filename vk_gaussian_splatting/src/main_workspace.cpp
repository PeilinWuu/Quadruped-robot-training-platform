#include "main_workspace.h"

#include "application_state.h"

#include <algorithm>
#include <chrono>
#include <cfloat>
#include <cstdio>
#include <utility>

#include <imgui/imgui_internal.h>

namespace vk_gaussian_splatting {

namespace {

constexpr ImVec4 kAccent{0.10F, 0.66F, 0.87F, 1.0F};
constexpr ImVec4 kGood{0.26F, 0.84F, 0.61F, 1.0F};
constexpr ImVec4 kWarning{0.93F, 0.63F, 0.29F, 1.0F};
constexpr ImVec4 kDanger{0.94F, 0.35F, 0.40F, 1.0F};
constexpr ImVec4 kMock{0.78F, 0.58F, 0.25F, 1.0F};

void drawBadge(const char* text, const ImVec4& color)
{
  ImGui::PushStyleColor(ImGuiCol_Text, color);
  ImGui::TextUnformatted(text);
  ImGui::PopStyleColor();
}

void labelValue(const char* label, const char* value)
{
  ImGui::TableNextRow();
  ImGui::TableSetColumnIndex(0);
  ImGui::TextDisabled("%s", label);
  ImGui::TableSetColumnIndex(1);
  ImGui::TextUnformatted(value);
}

float secondsSince(std::chrono::steady_clock::time_point timestamp)
{
  if(timestamp == std::chrono::steady_clock::time_point{})
    return 0.0F;
  return std::max(0.0F, std::chrono::duration<float>(std::chrono::steady_clock::now() - timestamp).count());
}

}  // namespace

void buildMonitoringDockLayout(ImGuiID dockspaceId)
{
  ImGui::DockBuilderRemoveNodeDockedWindows(dockspaceId, true);
  ImGui::DockBuilderRemoveNodeChildNodes(dockspaceId);

  ImGuiID centerId = dockspaceId;
  ImGuiID topId    = ImGui::DockBuilderSplitNode(centerId, ImGuiDir_Up, 0.09F, nullptr, &centerId);
  ImGuiID bottomId = ImGui::DockBuilderSplitNode(centerId, ImGuiDir_Down, 0.25F, nullptr, &centerId);
  ImGuiID leftId   = ImGui::DockBuilderSplitNode(centerId, ImGuiDir_Left, 0.20F, nullptr, &centerId);
  ImGuiID rightId  = ImGui::DockBuilderSplitNode(centerId, ImGuiDir_Right, 0.22F, nullptr, &centerId);

  ImGui::DockBuilderDockWindow("Project Status", topId);
  ImGui::DockBuilderDockWindow("Scene & Environment", leftId);
  ImGui::DockBuilderDockWindow("Assets", leftId);
  ImGui::DockBuilderDockWindow("Robot & Sensors", rightId);
  ImGui::DockBuilderDockWindow("Properties", rightId);
  ImGui::DockBuilderDockWindow("Training Monitor", bottomId);
  ImGui::DockBuilderDockWindow("Export Preview", bottomId);
  ImGui::DockBuilderDockWindow("Profiler", bottomId);
  ImGui::DockBuilderDockWindow("Memory Statistics", bottomId);
  ImGui::DockBuilderDockWindow("Rendering Statistics", bottomId);
  ImGui::DockBuilderDockWindow("Viewport", centerId);

  if(ImGuiDockNode* central = ImGui::DockBuilderGetCentralNode(dockspaceId))
    central->LocalFlags |= ImGuiDockNodeFlags_NoTabBar;
  ImGui::DockBuilderFinish(dockspaceId);
}

void MainWorkspace::init(ApplicationState* state, WorkspaceCallbacks callbacks)
{
  m_state     = state;
  m_callbacks = std::move(callbacks);
}

void MainWorkspace::deinit()
{
  m_state = nullptr;
  m_callbacks = {};
}

void MainWorkspace::draw()
{
  if(m_state == nullptr)
    return;

  if(m_state->ui.requestMonitoringLayoutReset)
  {
    char hostName[32];
    std::snprintf(hostName, sizeof(hostName), "WindowOverViewport_%08X", ImGui::GetMainViewport()->ID);
    if(ImGuiWindow* host = ImGui::FindWindowByName(hostName))
    {
      buildMonitoringDockLayout(host->GetID("DockSpace"));
      ImGui::SetWindowFocus("Training Monitor");
    }
    m_state->ui.requestMonitoringLayoutReset = false;
  }

  drawProjectStatus();
  drawSceneAndEnvironment();
  drawRobotAndSensors();
  drawTrainingMonitor();
  drawStatusBar();
}

void MainWorkspace::drawProjectStatus()
{
  if(!m_state->ui.showProjectStatus)
    return;

  ImGui::SetNextWindowSizeConstraints(ImVec2(420.0F, 70.0F), ImVec2(FLT_MAX, FLT_MAX));
  if(ImGui::Begin("Project Status", &m_state->ui.showProjectStatus, ImGuiWindowFlags_NoScrollbar))
  {
    ImGui::PushStyleColor(ImGuiCol_Text, kAccent);
    ImGui::TextUnformatted(m_state->project.projectName.c_str());
    ImGui::PopStyleColor();
    ImGui::SameLine();
    drawBadge("MONITORING UI 1A", kGood);

    if(ImGui::BeginTable("ProjectStatusGrid", 8, ImGuiTableFlags_SizingStretchSame))
    {
      ImGui::TableNextRow();
      ImGui::TableSetColumnIndex(0);
      ImGui::TextDisabled("Scene");
      ImGui::TableSetColumnIndex(1);
      ImGui::TextUnformatted(toString(m_state->render.loadState));
      ImGui::TableSetColumnIndex(2);
      ImGui::TextDisabled("Gaussians");
      ImGui::TableSetColumnIndex(3);
      ImGui::Text("%llu", static_cast<unsigned long long>(m_state->render.gaussianCount));
      ImGui::TableSetColumnIndex(4);
      ImGui::TextDisabled("Pipeline");
      ImGui::TableSetColumnIndex(5);
      ImGui::TextUnformatted(m_state->render.pipelineName.c_str());
      ImGui::TableSetColumnIndex(6);
      ImGui::TextDisabled("Viewport / FPS");
      ImGui::TableSetColumnIndex(7);
      ImGui::Text("%ux%u / %.1f", m_state->render.viewportWidth, m_state->render.viewportHeight, m_state->render.fps);
      ImGui::EndTable();
    }
  }
  ImGui::End();
}

void MainWorkspace::drawSceneAndEnvironment()
{
  if(!m_state->ui.showSceneEnvironment)
    return;

  ImGui::SetNextWindowSizeConstraints(ImVec2(250.0F, 300.0F), ImVec2(FLT_MAX, FLT_MAX));
  if(ImGui::Begin("Scene & Environment", &m_state->ui.showSceneEnvironment))
  {
    drawBadge("MOCK ENVIRONMENT PARAMETERS", kMock);
    ImGui::SeparatorText("Scene Summary");
    if(ImGui::BeginTable("SceneSummary", 2, ImGuiTableFlags_SizingStretchProp | ImGuiTableFlags_RowBg))
    {
      labelValue("Scenario", m_state->scene.name.c_str());
      labelValue("Building", m_state->scene.building.c_str());
      labelValue("Floor", m_state->scene.floor.c_str());
      labelValue("Fire location", m_state->scene.fireLocation.c_str());
      ImGui::TableNextRow();
      ImGui::TableSetColumnIndex(0);
      ImGui::TextDisabled("Risk");
      ImGui::TableSetColumnIndex(1);
      drawBadge(m_state->scene.riskLevel.c_str(), kDanger);
      ImGui::EndTable();
    }

    const std::string sceneFile = m_state->render.sceneFilename.empty() ? "No GS scene loaded" : m_state->render.sceneFilename.filename().string();
    ImGui::TextDisabled("GS scene");
    ImGui::TextWrapped("%s", sceneFile.c_str());

    ImGui::SeparatorText("Environment (MOCK only)");
    ImGui::SliderFloat("Fire intensity", &m_state->environment.fireIntensity, 0.0F, 100.0F, "%.0f %%");
    ImGui::SliderFloat("Smoke density", &m_state->environment.smokeDensity, 0.0F, 100.0F, "%.0f %%");
    ImGui::SliderFloat("Ambient temp.", &m_state->environment.ambientTemperature, 0.0F, 100.0F, "%.1f C");
    ImGui::SliderFloat("Obstacle density", &m_state->environment.obstacleDensity, 0.0F, 100.0F, "%.0f %%");
    ImGui::Spacing();
    ImGui::TextColored(kWarning, "Display only - does not modify GS rendering");
  }
  ImGui::End();
}

void MainWorkspace::drawRobotAndSensors()
{
  if(!m_state->ui.showRobotSensors)
    return;

  ImGui::SetNextWindowSizeConstraints(ImVec2(290.0F, 380.0F), ImVec2(FLT_MAX, FLT_MAX));
  if(ImGui::Begin("Robot & Sensors", &m_state->ui.showRobotSensors))
  {
    drawBadge("MOCK ROBOT DATA", kMock);
    ImGui::SameLine();
    drawBadge(toString(m_state->robot.connection), m_state->robot.connection == ConnectionState::Online ? kGood : kDanger);

    ImGui::SeparatorText("Robot Status");
    if(ImGui::BeginTable("RobotStatus", 2, ImGuiTableFlags_SizingStretchProp | ImGuiTableFlags_RowBg))
    {
      labelValue("Control mode", toString(m_state->robot.appliedControlMode));
      ImGui::TableNextRow();
      ImGui::TableSetColumnIndex(0); ImGui::TextDisabled("Battery");
      ImGui::TableSetColumnIndex(1); ImGui::Text("%.1f %%", m_state->robot.batteryPercent);
      ImGui::TableNextRow();
      ImGui::TableSetColumnIndex(0); ImGui::TextDisabled("Linear velocity");
      ImGui::TableSetColumnIndex(1); ImGui::Text("%.3f m/s", m_state->robot.linearVelocity);
      ImGui::TableNextRow();
      ImGui::TableSetColumnIndex(0); ImGui::TextDisabled("Angular velocity");
      ImGui::TableSetColumnIndex(1); ImGui::Text("%.3f rad/s", m_state->robot.angularVelocity);
      ImGui::TableNextRow();
      ImGui::TableSetColumnIndex(0); ImGui::TextDisabled("Position");
      ImGui::TableSetColumnIndex(1); ImGui::Text("%.2f, %.2f, %.2f", m_state->robot.position.x, m_state->robot.position.y, m_state->robot.position.z);
      ImGui::TableNextRow();
      ImGui::TableSetColumnIndex(0); ImGui::TextDisabled("Orientation R/P/Y");
      ImGui::TableSetColumnIndex(1); ImGui::Text("%.2f, %.2f, %.2f", m_state->robot.orientationRpy.x, m_state->robot.orientationRpy.y, m_state->robot.orientationRpy.z);
      ImGui::EndTable();
    }

    int controlMode = static_cast<int>(m_state->robot.requestedControlMode);
    const char* modes[] = {"Autonomous", "Assisted", "Manual"};
    if(ImGui::Combo("Requested mode", &controlMode, modes, IM_ARRAYSIZE(modes)) && m_callbacks.requestControlMode)
      m_callbacks.requestControlMode(static_cast<ControlMode>(controlMode));

    ImGui::SeparatorText("Sensor Status");
    drawBadge("MOCK SENSOR DATA", kMock);
    if(ImGui::BeginTable("SensorStatus", 2, ImGuiTableFlags_SizingStretchProp | ImGuiTableFlags_RowBg))
    {
      ImGui::TableNextRow(); ImGui::TableSetColumnIndex(0); ImGui::TextDisabled("Temperature"); ImGui::TableSetColumnIndex(1); ImGui::Text("%.1f C", m_state->sensors.temperatureC);
      ImGui::TableNextRow(); ImGui::TableSetColumnIndex(0); ImGui::TextDisabled("Smoke"); ImGui::TableSetColumnIndex(1); ImGui::Text("%.3f", m_state->sensors.smokeDensity);
      ImGui::TableNextRow(); ImGui::TableSetColumnIndex(0); ImGui::TextDisabled("Visibility"); ImGui::TableSetColumnIndex(1); ImGui::Text("%.2f m", m_state->sensors.visibilityMeters);
      ImGui::TableNextRow(); ImGui::TableSetColumnIndex(0); ImGui::TextDisabled("Oxygen"); ImGui::TableSetColumnIndex(1); ImGui::Text("%.1f %%", m_state->sensors.oxygenPercent);
      labelValue("LiDAR", toString(m_state->sensors.lidar));
      labelValue("RGB camera", toString(m_state->sensors.rgbCamera));
      labelValue("Depth camera", toString(m_state->sensors.depthCamera));
      ImGui::EndTable();
    }
    ImGui::TextDisabled("Updates are deterministic and limited to 4-5 Hz");
    ImGui::Text("Last update: %.2f s ago", secondsSince(m_state->robot.lastUpdate));
  }
  ImGui::End();
}

void MainWorkspace::drawTrainingMonitor()
{
  if(!m_state->ui.showTrainingMonitor)
    return;

  ImGui::SetNextWindowSizeConstraints(ImVec2(520.0F, 220.0F), ImVec2(FLT_MAX, FLT_MAX));
  if(ImGui::Begin("Training Monitor", &m_state->ui.showTrainingMonitor))
  {
    drawBadge("MOCK TRAINING DATA", kMock);
    ImGui::SameLine();
    const ImVec4 stateColor = m_state->training.state == TrainingRunState::Running ? kGood :
                              m_state->training.state == TrainingRunState::Paused  ? kWarning : kDanger;
    drawBadge(toString(m_state->training.state), stateColor);

    ImGui::SeparatorText("Task");
    ImGui::TextUnformatted(m_state->training.taskName.c_str());
    if(ImGui::BeginTable("TrainingSummary", 4, ImGuiTableFlags_SizingStretchSame | ImGuiTableFlags_RowBg))
    {
      ImGui::TableNextRow();
      ImGui::TableSetColumnIndex(0); ImGui::TextDisabled("Episode");
      ImGui::TableSetColumnIndex(1); ImGui::Text("%u", m_state->training.episode);
      ImGui::TableSetColumnIndex(2); ImGui::TextDisabled("Step");
      ImGui::TableSetColumnIndex(3); ImGui::Text("%u", m_state->training.step);
      ImGui::TableNextRow();
      ImGui::TableSetColumnIndex(0); ImGui::TextDisabled("Reward");
      ImGui::TableSetColumnIndex(1); ImGui::Text("%.2f", m_state->training.reward);
      ImGui::TableSetColumnIndex(2); ImGui::TextDisabled("Loss");
      ImGui::TableSetColumnIndex(3); ImGui::Text("%.4f", m_state->training.loss);
      ImGui::TableNextRow();
      ImGui::TableSetColumnIndex(0); ImGui::TextDisabled("Success rate");
      ImGui::TableSetColumnIndex(1); ImGui::Text("%.1f %%", m_state->training.successRate);
      ImGui::TableSetColumnIndex(2); ImGui::TextDisabled("Elapsed");
      ImGui::TableSetColumnIndex(3); ImGui::Text("%.1f s", std::chrono::duration<float>(m_state->training.elapsed).count());
      ImGui::EndTable();
    }

    const bool idle    = m_state->training.state == TrainingRunState::Idle;
    const bool running = m_state->training.state == TrainingRunState::Running;
    const bool paused  = m_state->training.state == TrainingRunState::Paused;
    const bool stopped = m_state->training.state == TrainingRunState::Stopped;
    ImGui::BeginDisabled(!idle && !stopped);
    if(ImGui::Button(stopped ? "Restart MOCK task" : "Start MOCK task") && m_callbacks.requestTrainingCommand)
      m_callbacks.requestTrainingCommand(TrainingCommand::Start);
    ImGui::EndDisabled();
    ImGui::SameLine();
    ImGui::BeginDisabled(!running);
    if(ImGui::Button("Pause") && m_callbacks.requestTrainingCommand)
      m_callbacks.requestTrainingCommand(TrainingCommand::Pause);
    ImGui::EndDisabled();
    ImGui::SameLine();
    ImGui::BeginDisabled(!paused);
    if(ImGui::Button("Resume") && m_callbacks.requestTrainingCommand)
      m_callbacks.requestTrainingCommand(TrainingCommand::Resume);
    ImGui::EndDisabled();
    ImGui::SameLine();
    ImGui::BeginDisabled(stopped);
    if(ImGui::Button("Stop") && m_callbacks.requestTrainingCommand)
      m_callbacks.requestTrainingCommand(TrainingCommand::Stop);
    ImGui::EndDisabled();

    ImGui::TextDisabled("Automatic MOCK sequence: Idle -> Running -> Paused -> Running -> Stopped");
    ImGui::Text("Last update: %.2f s ago", secondsSince(m_state->training.lastUpdate));
  }
  ImGui::End();
}

void MainWorkspace::drawStatusBar()
{
  if(!m_state->ui.showStatusBar)
    return;

  const ImGuiWindowFlags flags = ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_MenuBar;
  if(ImGui::BeginViewportSideBar("##MonitoringStatusBar", nullptr, ImGuiDir_Down, ImGui::GetFrameHeight(), flags))
  {
    if(ImGui::BeginMenuBar())
    {
      drawBadge("NATIVE MONITOR", kAccent);
      ImGui::SameLine();
      ImGui::TextDisabled(" | Data source:");
      ImGui::SameLine();
      drawBadge("MOCK", kMock);
      ImGui::SameLine();
      ImGui::TextDisabled(" | GS:");
      ImGui::SameLine();
      ImGui::TextUnformatted(toString(m_state->render.loadState));
      ImGui::SameLine();
      ImGui::TextDisabled(" | Training:");
      ImGui::SameLine();
      ImGui::TextUnformatted(toString(m_state->training.state));
      ImGui::SameLine(ImGui::GetWindowContentRegionMax().x - 190.0F);
      ImGui::Text("Viewport %ux%u  %.1f FPS", m_state->render.viewportWidth, m_state->render.viewportHeight, m_state->render.fps);
      ImGui::EndMenuBar();
    }
    ImGui::End();
  }
}

}  // namespace vk_gaussian_splatting
