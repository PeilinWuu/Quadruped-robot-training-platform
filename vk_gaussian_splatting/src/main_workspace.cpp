#include "main_workspace.h"

#include "application_state.h"

#include <algorithm>
#include <chrono>
#include <cfloat>
#include <cmath>
#include <cstdio>
#include <limits>
#include <utility>

#include <imgui/imgui_internal.h>
#include <implot/implot.h>
#include <glm/geometric.hpp>

namespace vk_gaussian_splatting {

namespace {

constexpr ImVec4 kAccent{0.10F, 0.66F, 0.87F, 1.0F};
constexpr ImVec4 kGood{0.26F, 0.84F, 0.61F, 1.0F};
constexpr ImVec4 kWarning{0.93F, 0.63F, 0.29F, 1.0F};
constexpr ImVec4 kDanger{0.94F, 0.35F, 0.40F, 1.0F};
constexpr ImVec4 kMock{0.78F, 0.58F, 0.25F, 1.0F};

struct TrainingPlotData
{
  const TrainingHistory* history;
  enum class Field { Reward, PolicyLoss, ValueLoss, SuccessRate } field;
};

ImPlotPoint trainingGetter(int index, void* userData)
{
  const auto& data   = *static_cast<TrainingPlotData*>(userData);
  const auto& sample = (*data.history)[static_cast<std::size_t>(index)];
  double value = 0.0;
  switch(data.field)
  {
    case TrainingPlotData::Field::Reward: value = sample.reward; break;
    case TrainingPlotData::Field::PolicyLoss: value = sample.policyLoss; break;
    case TrainingPlotData::Field::ValueLoss: value = sample.valueLoss; break;
    case TrainingPlotData::Field::SuccessRate: value = sample.successRate; break;
  }
  return {static_cast<double>(sample.episode), value};
}

struct PerformancePlotData
{
  const PerformanceHistory* history;
  enum class Field { Fps, Gpu, Cpu, Memory } field;
};

ImPlotPoint performanceGetter(int index, void* userData)
{
  const auto& data   = *static_cast<PerformancePlotData*>(userData);
  const auto& sample = (*data.history)[static_cast<std::size_t>(index)];
  double value = std::numeric_limits<double>::quiet_NaN();
  switch(data.field)
  {
    case PerformancePlotData::Field::Fps: if(sample.fpsValid) value = sample.fps; break;
    case PerformancePlotData::Field::Gpu: if(sample.gpuFrameTimeValid) value = sample.gpuFrameTimeMs; break;
    case PerformancePlotData::Field::Cpu: if(sample.cpuUiTimeValid) value = sample.cpuUiTimeMs; break;
    case PerformancePlotData::Field::Memory: if(sample.gpuMemoryValid) value = sample.gpuMemoryMb; break;
  }
  return {sample.timestamp, value};
}

const char* severityName(LogSeverity severity)
{
  switch(severity)
  {
    case LogSeverity::Debug: return "DEBUG";
    case LogSeverity::Info: return "INFO";
    case LogSeverity::Warning: return "WARNING";
    case LogSeverity::Error: return "ERROR";
  }
  return "UNKNOWN";
}

ImVec4 severityColor(LogSeverity severity)
{
  switch(severity)
  {
    case LogSeverity::Debug: return ImVec4(0.60F, 0.63F, 0.68F, 1.0F);
    case LogSeverity::Info: return kAccent;
    case LogSeverity::Warning: return kWarning;
    case LogSeverity::Error: return kDanger;
  }
  return ImGui::GetStyleColorVec4(ImGuiCol_Text);
}

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
  ImGui::DockBuilderDockWindow("Training Charts", bottomId);
  ImGui::DockBuilderDockWindow("Performance Charts", bottomId);
  ImGui::DockBuilderDockWindow("Navigation Map", bottomId);
  ImGui::DockBuilderDockWindow("Event Log", bottomId);
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
  m_started = std::chrono::steady_clock::now();
  m_nextTrainingSample = m_nextPerformanceSample = m_nextNavigationSample = m_started;
  m_lastTrainingState = state != nullptr ? state->training.state : TrainingRunState::Idle;
  if(state != nullptr)
    state->navigation.mapPan = {-state->navigation.robotPosition2D.x * state->navigation.mapZoom,
                                state->navigation.robotPosition2D.y * state->navigation.mapZoom};
  addLog(LogSeverity::Info, "System", "MainWorkspace initialized (MOCK data sources)");
}

void MainWorkspace::deinit()
{
  m_state = nullptr;
  m_callbacks = {};
}

void MainWorkspace::addLog(LogSeverity severity, std::string category, std::string message)
{
  if(m_state == nullptr)
    return;
  LogEntry entry;
  entry.sequence  = m_state->log.nextSequence++;
  entry.timestamp = std::chrono::duration<double>(std::chrono::steady_clock::now() - m_started).count();
  entry.severity  = severity;
  entry.category  = std::move(category);
  entry.message   = std::move(message);
  m_state->log.entries.push(std::move(entry));
  if(severity == LogSeverity::Warning)
    ++m_state->log.warningCount;
  else if(severity == LogSeverity::Error)
    ++m_state->log.errorCount;
}

void MainWorkspace::update(std::chrono::steady_clock::time_point now)
{
  if(m_state == nullptr)
    return;

  if(m_state->training.state != m_lastTrainingState)
  {
    const char* action = "changed state";
    switch(m_state->training.state)
    {
      case TrainingRunState::Running: action = m_lastTrainingState == TrainingRunState::Paused ? "resumed" : "started"; break;
      case TrainingRunState::Paused: action = "paused"; break;
      case TrainingRunState::Stopped: action = "stopped"; break;
      case TrainingRunState::Idle: action = "reset"; break;
    }
    addLog(LogSeverity::Info, "Training", std::string("Mock training ") + action);
    m_lastTrainingState = m_state->training.state;
  }

  if(now >= m_nextTrainingSample)
  {
    m_nextTrainingSample = now + std::chrono::milliseconds(250);
    if(m_state->training.state == TrainingRunState::Running)
    {
      const float t = std::chrono::duration<float>(m_state->training.elapsed).count();
      m_state->trainingHistory.push({std::chrono::duration<double>(now - m_started).count(), m_state->training.episode,
                                     m_state->training.reward, m_state->training.loss,
                                     std::max(0.01F, m_state->training.loss * 0.72F + 0.025F * std::sin(t * 0.41F)),
                                     m_state->training.successRate});
    }
  }

  if(now >= m_nextPerformanceSample && m_state->ui.showPerformanceCharts)
  {
    m_nextPerformanceSample = now + std::chrono::milliseconds(250);
    m_state->performanceHistory.push({std::chrono::duration<double>(now - m_started).count(), m_state->render.fps,
                                      m_state->render.gpuFrameTimeMs, m_state->render.cpuUiTimeMs, m_state->render.gpuMemoryMb,
                                      std::isfinite(m_state->render.fps) && m_state->render.fps > 0.0F,
                                      m_state->render.gpuFrameTimeValid, m_state->render.cpuUiTimeValid,
                                      m_state->render.gpuMemoryValid});
  }

  if(now >= m_nextNavigationSample)
  {
    m_nextNavigationSample = now + std::chrono::milliseconds(100);
    m_state->navigation.robotPosition2D = {m_state->robot.position.x, m_state->robot.position.y};
    m_state->navigation.robotHeading = m_state->robot.orientationRpy.z;
    const auto& path = m_state->navigation.pathPoints;
    if(path.empty() || glm::length(m_state->navigation.robotPosition2D - path[path.size() - 1]) >= 0.015F)
      m_state->navigation.pathPoints.push(m_state->navigation.robotPosition2D);
  }
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
      addLog(LogSeverity::Info, "System", "Monitoring layout reset");
    }
    m_state->ui.requestMonitoringLayoutReset = false;
  }

  drawProjectStatus();
  drawSceneAndEnvironment();
  drawRobotAndSensors();
  drawTrainingMonitor();
  drawTrainingCharts();
  drawPerformanceCharts();
  drawNavigationMap();
  drawEventLog();
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
    drawBadge("MONITORING UI 1B", kGood);

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
    ImGui::SameLine();
    ImGui::BeginDisabled(running || paused);
    if(ImGui::Button("Reset Mock Training") && m_callbacks.resetMockTraining)
    {
      m_callbacks.resetMockTraining();
      m_state->trainingHistory.clear();
      addLog(LogSeverity::Info, "Training", "Mock training history reset");
    }
    ImGui::EndDisabled();

    ImGui::TextDisabled("Automatic MOCK sequence: Idle -> Running -> Paused -> Running -> Stopped");
    ImGui::Text("Last update: %.2f s ago", secondsSince(m_state->training.lastUpdate));
  }
  ImGui::End();
}

void MainWorkspace::drawTrainingCharts()
{
  if(!m_state->ui.showTrainingCharts)
    return;
  if(ImGui::Begin("Training Charts", &m_state->ui.showTrainingCharts))
  {
    drawBadge("MOCK TRAINING HISTORY", kMock);
    const auto& history = m_state->trainingHistory;
    if(history.size() < 2)
    {
      ImGui::TextDisabled("Waiting for Running training samples...");
      ImGui::End();
      return;
    }

    float rewardMin = history[0].reward, rewardMax = history[0].reward, rewardSum = 0.0F;
    const std::size_t recentStart = history.size() > 20 ? history.size() - 20 : 0;
    std::size_t recentCount = 0;
    for(std::size_t i = 0; i < history.size(); ++i)
    {
      rewardMin = std::min(rewardMin, history[i].reward);
      rewardMax = std::max(rewardMax, history[i].reward);
      if(i >= recentStart) { rewardSum += history[i].reward; ++recentCount; }
    }
    const auto& current = history[history.size() - 1];
    ImGui::Text("Episode %u | Reward %.2f | Recent avg %.2f | Min %.2f | Max %.2f",
                current.episode, current.reward, rewardSum / static_cast<float>(recentCount), rewardMin, rewardMax);

    TrainingPlotData reward{&history, TrainingPlotData::Field::Reward};
    if(ImPlot::BeginPlot("Reward", ImVec2(-1.0F, 150.0F)))
    {
      ImPlot::SetupAxes("Episode", "Reward", ImPlotAxisFlags_AutoFit, ImPlotAxisFlags_AutoFit);
      ImPlot::PlotLineG("Reward", trainingGetter, &reward, static_cast<int>(history.size()));
      ImPlot::EndPlot();
    }
    TrainingPlotData policy{&history, TrainingPlotData::Field::PolicyLoss};
    TrainingPlotData value{&history, TrainingPlotData::Field::ValueLoss};
    if(ImPlot::BeginPlot("Loss", ImVec2(-1.0F, 150.0F)))
    {
      ImPlot::SetupAxes("Episode", "Loss", ImPlotAxisFlags_AutoFit, ImPlotAxisFlags_AutoFit);
      ImPlot::SetupAxisLimitsConstraints(ImAxis_Y1, 0.0, std::numeric_limits<double>::infinity());
      ImPlot::PlotLineG("Policy Loss", trainingGetter, &policy, static_cast<int>(history.size()));
      ImPlot::PlotLineG("Value Loss", trainingGetter, &value, static_cast<int>(history.size()));
      ImPlot::EndPlot();
    }
    TrainingPlotData success{&history, TrainingPlotData::Field::SuccessRate};
    if(ImPlot::BeginPlot("Success Rate", ImVec2(-1.0F, 150.0F)))
    {
      ImPlot::SetupAxes("Episode", "Percent", ImPlotAxisFlags_AutoFit, ImPlotAxisFlags_None);
      ImPlot::SetupAxisLimits(ImAxis_Y1, 0.0, 100.0, ImPlotCond_Always);
      ImPlot::SetupAxisLimitsConstraints(ImAxis_Y1, 0.0, 100.0);
      ImPlot::PlotLineG("Success Rate", trainingGetter, &success, static_cast<int>(history.size()));
      ImPlot::EndPlot();
    }
  }
  ImGui::End();
}

void MainWorkspace::drawPerformanceCharts()
{
  if(!m_state->ui.showPerformanceCharts)
    return;
  if(ImGui::Begin("Performance Charts", &m_state->ui.showPerformanceCharts))
  {
    ImGui::TextDisabled("Sources: FPS = ImGui frame timing; GPU = existing Profiler snapshots; CPU UI = measured UI render time; GPU memory = N/A.");
    const auto& history = m_state->performanceHistory;
    if(history.size() < 2)
    {
      ImGui::TextDisabled("Waiting for performance samples...");
      ImGui::End();
      return;
    }
    float fpsSum = 0.0F;
    std::size_t fpsCount = 0;
    const std::size_t start = history.size() > 20 ? history.size() - 20 : 0;
    for(std::size_t i = start; i < history.size(); ++i)
      if(history[i].fpsValid) { fpsSum += history[i].fps; ++fpsCount; }
    const auto& current = history[history.size() - 1];
    ImGui::Text("FPS %.1f | Recent avg %.1f | GPU frame %s | CPU UI %s | GPU memory N/A",
                current.fps, fpsCount ? fpsSum / static_cast<float>(fpsCount) : 0.0F,
                current.gpuFrameTimeValid ? "available" : "N/A", current.cpuUiTimeValid ? "available" : "N/A");

    PerformancePlotData fps{&history, PerformancePlotData::Field::Fps};
    if(ImPlot::BeginPlot("FPS", ImVec2(-1.0F, 160.0F)))
    {
      ImPlot::SetupAxes("Time (s)", "FPS", ImPlotAxisFlags_AutoFit, ImPlotAxisFlags_AutoFit);
      ImPlot::SetupAxisLimitsConstraints(ImAxis_Y1, 0.0, std::numeric_limits<double>::infinity());
      ImPlot::PlotLineG("FPS", performanceGetter, &fps, static_cast<int>(history.size()));
      ImPlot::EndPlot();
    }
    PerformancePlotData gpu{&history, PerformancePlotData::Field::Gpu};
    PerformancePlotData cpu{&history, PerformancePlotData::Field::Cpu};
    if(ImPlot::BeginPlot("Frame Times", ImVec2(-1.0F, 160.0F)))
    {
      ImPlot::SetupAxes("Time (s)", "Milliseconds", ImPlotAxisFlags_AutoFit, ImPlotAxisFlags_AutoFit);
      ImPlot::SetupAxisLimitsConstraints(ImAxis_Y1, 0.0, std::numeric_limits<double>::infinity());
      ImPlot::PlotLineG("GPU Frame", performanceGetter, &gpu, static_cast<int>(history.size()));
      ImPlot::PlotLineG("CPU UI", performanceGetter, &cpu, static_cast<int>(history.size()));
      ImPlot::EndPlot();
    }
  }
  ImGui::End();
}

void MainWorkspace::drawNavigationMap()
{
  if(!m_state->ui.showNavigationMap)
    return;
  auto& nav = m_state->navigation;
  if(ImGui::Begin("Navigation Map", &m_state->ui.showNavigationMap))
  {
    drawBadge("MOCK MAP", kMock);
    ImGui::SameLine();
    ImGui::TextDisabled("Mock visualization — not SLAM/navigation ground truth");
    int tool = static_cast<int>(nav.tool);
    ImGui::RadioButton("Inspect", &tool, static_cast<int>(NavigationTool::Inspect)); ImGui::SameLine();
    ImGui::RadioButton("Set Target", &tool, static_cast<int>(NavigationTool::SetTarget));
    nav.tool = static_cast<NavigationTool>(tool);
    ImGui::SameLine();
    if(ImGui::Button("Clear Target") && nav.targetValid) { nav.targetValid = false; addLog(LogSeverity::Info, "Map", "Mock target cleared"); }
    ImGui::SameLine();
    if(ImGui::Button("Clear Path")) { nav.pathPoints.clear(); addLog(LogSeverity::Info, "Map", "Mock path cleared"); }
    ImGui::SameLine();
    if(ImGui::Button("Center Robot")) nav.mapPan = {-nav.robotPosition2D.x * nav.mapZoom, nav.robotPosition2D.y * nav.mapZoom};
    ImGui::SameLine();
    if(ImGui::Button("Reset View")) { nav.mapZoom = 16.0F; nav.mapPan = {-nav.robotPosition2D.x * nav.mapZoom, nav.robotPosition2D.y * nav.mapZoom}; addLog(LogSeverity::Info, "Map", "Mock map view reset"); }

    ImVec2 canvasSize = ImGui::GetContentRegionAvail();
    canvasSize.y = std::max(canvasSize.y, 180.0F);
    if(canvasSize.x > 1.0F && canvasSize.y > 1.0F)
    {
      const ImVec2 origin = ImGui::GetCursorScreenPos();
      ImGui::InvisibleButton("##MockMapCanvas", canvasSize, ImGuiButtonFlags_MouseButtonLeft | ImGuiButtonFlags_MouseButtonRight | ImGuiButtonFlags_MouseButtonMiddle);
      const bool hovered = ImGui::IsItemHovered();
      const ImVec2 center{origin.x + canvasSize.x * 0.5F, origin.y + canvasSize.y * 0.5F};
      auto worldToScreen = [&](glm::vec2 point) {
        return ImVec2(center.x + nav.mapPan.x + point.x * nav.mapZoom, center.y + nav.mapPan.y - point.y * nav.mapZoom);
      };
      auto screenToWorld = [&](ImVec2 point) {
        const float zoom = std::max(nav.mapZoom, 0.1F);
        return glm::vec2((point.x - center.x - nav.mapPan.x) / zoom, -(point.y - center.y - nav.mapPan.y) / zoom);
      };
      if(hovered && ImGui::GetIO().MouseWheel != 0.0F)
      {
        const ImVec2 mouse = ImGui::GetMousePos();
        const glm::vec2 before = screenToWorld(mouse);
        nav.mapZoom = std::clamp(nav.mapZoom * std::pow(1.15F, ImGui::GetIO().MouseWheel), 0.1F, 20.0F);
        const ImVec2 afterScreen = worldToScreen(before);
        nav.mapPan.x += mouse.x - afterScreen.x;
        nav.mapPan.y += mouse.y - afterScreen.y;
      }
      if(hovered && (ImGui::IsMouseDragging(ImGuiMouseButton_Right) || ImGui::IsMouseDragging(ImGuiMouseButton_Middle)))
      {
        nav.mapPan.x += ImGui::GetIO().MouseDelta.x;
        nav.mapPan.y += ImGui::GetIO().MouseDelta.y;
      }
      if(hovered && nav.tool == NavigationTool::SetTarget && ImGui::IsMouseClicked(ImGuiMouseButton_Left))
      {
        const glm::vec2 target = screenToWorld(ImGui::GetMousePos());
        if(std::isfinite(target.x) && std::isfinite(target.y))
        {
          nav.targetPoint = target; nav.targetValid = true;
          addLog(LogSeverity::Info, "Map", "Mock target set");
        }
      }

      ImDrawList* draw = ImGui::GetWindowDrawList();
      draw->PushClipRect(origin, ImVec2(origin.x + canvasSize.x, origin.y + canvasSize.y), true);
      draw->AddRectFilled(origin, ImVec2(origin.x + canvasSize.x, origin.y + canvasSize.y), IM_COL32(18, 23, 30, 255));
      const float gridWorld = 5.0F;
      const glm::vec2 topLeft = screenToWorld(origin);
      const glm::vec2 bottomRight = screenToWorld({origin.x + canvasSize.x, origin.y + canvasSize.y});
      const int x0 = static_cast<int>(std::floor(topLeft.x / gridWorld));
      const int x1 = static_cast<int>(std::ceil(bottomRight.x / gridWorld));
      const int y0 = static_cast<int>(std::floor(bottomRight.y / gridWorld));
      const int y1 = static_cast<int>(std::ceil(topLeft.y / gridWorld));
      if(x1 - x0 < 500 && y1 - y0 < 500)
      {
        for(int x = x0; x <= x1; ++x) { const float sx = worldToScreen({x * gridWorld, 0}).x; draw->AddLine({sx, origin.y}, {sx, origin.y + canvasSize.y}, IM_COL32(47, 56, 67, 180)); }
        for(int y = y0; y <= y1; ++y) { const float sy = worldToScreen({0, y * gridWorld}).y; draw->AddLine({origin.x, sy}, {origin.x + canvasSize.x, sy}, IM_COL32(47, 56, 67, 180)); }
      }
      const ImVec2 axisOrigin = worldToScreen({0, 0});
      draw->AddLine({origin.x, axisOrigin.y}, {origin.x + canvasSize.x, axisOrigin.y}, IM_COL32(100, 120, 140, 220), 1.5F);
      draw->AddLine({axisOrigin.x, origin.y}, {axisOrigin.x, origin.y + canvasSize.y}, IM_COL32(100, 120, 140, 220), 1.5F);
      for(const auto& area : nav.obstacleAreas) { ImVec2 a=worldToScreen(area.min), b=worldToScreen(area.max); draw->AddRectFilled({a.x,b.y},{b.x,a.y},IM_COL32(105,112,122,180)); }
      for(const auto& area : nav.fireRiskAreas) { ImVec2 a=worldToScreen(area.min), b=worldToScreen(area.max); draw->AddRectFilled({a.x,b.y},{b.x,a.y},IM_COL32(210,65,40,105)); draw->AddRect({a.x,b.y},{b.x,a.y},IM_COL32(240,95,55,230)); }
      for(std::size_t i=1;i<nav.pathPoints.size();++i) draw->AddLine(worldToScreen(nav.pathPoints[i-1]),worldToScreen(nav.pathPoints[i]),IM_COL32(35,190,225,230),2.0F);
      if(nav.targetValid) { const ImVec2 p=worldToScreen(nav.targetPoint); draw->AddCircle(p,8.0F,IM_COL32(255,205,65,255),16,2.0F); draw->AddLine({p.x-10,p.y},{p.x+10,p.y},IM_COL32(255,205,65,255),2.0F); draw->AddLine({p.x,p.y-10},{p.x,p.y+10},IM_COL32(255,205,65,255),2.0F); }
      const ImVec2 robot = worldToScreen(nav.robotPosition2D);
      const ImVec2 nose{robot.x + std::cos(nav.robotHeading) * 15.0F, robot.y - std::sin(nav.robotHeading) * 15.0F};
      draw->AddCircleFilled(robot, 6.0F, IM_COL32(70,220,150,255)); draw->AddLine(robot,nose,IM_COL32(70,220,150,255),3.0F);
      draw->AddText({origin.x+8,origin.y+8},IM_COL32(225,170,70,255),"MOCK MAP | gray: Mock obstacles | red: Mock fire risk | cyan: Mock path");
      char zoomText[48]; std::snprintf(zoomText,sizeof(zoomText),"Zoom %.2f px/m",nav.mapZoom);
      draw->AddText({origin.x+8,origin.y+canvasSize.y-22},IM_COL32(190,200,210,255),zoomText);
      draw->PopClipRect();
    }
  }
  ImGui::End();
}

void MainWorkspace::drawEventLog()
{
  if(!m_state->ui.showEventLog)
    return;
  auto& log = m_state->log;
  if(ImGui::Begin("Event Log", &m_state->ui.showEventLog))
  {
    ImGui::Checkbox("Debug", &log.severityVisible[0]); ImGui::SameLine();
    ImGui::Checkbox("Info", &log.severityVisible[1]); ImGui::SameLine();
    ImGui::Checkbox("Warning", &log.severityVisible[2]); ImGui::SameLine();
    ImGui::Checkbox("Error", &log.severityVisible[3]); ImGui::SameLine();
    ImGui::Checkbox("Auto-scroll", &log.autoScroll); ImGui::SameLine();
    ImGui::Checkbox("Timestamps", &log.showTimestamp); ImGui::SameLine();
    const char* categories[] = {"All", "System", "Scene", "Training", "Robot", "Map"};
    int categoryIndex = 0;
    for(int i=1;i<IM_ARRAYSIZE(categories);++i) if(log.categoryFilter == categories[i]) categoryIndex=i;
    ImGui::SetNextItemWidth(110.0F);
    if(ImGui::Combo("Category", &categoryIndex, categories, IM_ARRAYSIZE(categories))) log.categoryFilter = categoryIndex == 0 ? "" : categories[categoryIndex];
    ImGui::SameLine();
    if(ImGui::Button("Clear")) { log.entries.clear(); log.warningCount=0; log.errorCount=0; }
    ImGui::Separator();
    if(ImGui::BeginChild("##EventLogScroll", ImVec2(0,0), false, ImGuiWindowFlags_HorizontalScrollbar))
    {
      for(std::size_t i=0;i<log.entries.size();++i)
      {
        const auto& entry = log.entries[i];
        if(!log.severityVisible[static_cast<std::size_t>(entry.severity)] || (!log.categoryFilter.empty() && entry.category != log.categoryFilter))
          continue;
        ImGui::PushStyleColor(ImGuiCol_Text, severityColor(entry.severity));
        if(log.showTimestamp) ImGui::Text("[%7.2f] #%llu %-7s [%-8s] %s", entry.timestamp, static_cast<unsigned long long>(entry.sequence), severityName(entry.severity), entry.category.c_str(), entry.message.c_str());
        else ImGui::Text("#%llu %-7s [%-8s] %s", static_cast<unsigned long long>(entry.sequence), severityName(entry.severity), entry.category.c_str(), entry.message.c_str());
        ImGui::PopStyleColor();
      }
      if(log.autoScroll) ImGui::SetScrollHereY(1.0F);
    }
    ImGui::EndChild();
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
      const std::string sceneName = m_state->render.sceneFilename.empty() ? "No scene" : m_state->render.sceneFilename.filename().string();
      ImGui::TextDisabled(" | Scene:");
      ImGui::SameLine();
      ImGui::TextUnformatted(sceneName.c_str());
      ImGui::SameLine();
      ImGui::TextDisabled(" | Load:");
      ImGui::SameLine();
      ImGui::TextUnformatted(toString(m_state->render.loadState));
      ImGui::SameLine();
      ImGui::TextDisabled(" | Pipeline:");
      ImGui::SameLine();
      ImGui::TextUnformatted(m_state->render.pipelineName.c_str());
      if(ImGui::GetContentRegionAvail().x > 540.0F)
      {
        ImGui::SameLine(); ImGui::TextDisabled(" | Sources:"); ImGui::SameLine(); drawBadge("Robot/Sensor/Training MOCK", kMock);
        ImGui::SameLine(); ImGui::TextDisabled(" | Training:"); ImGui::SameLine(); ImGui::TextUnformatted(toString(m_state->training.state));
      }
      if(ImGui::GetContentRegionAvail().x > 300.0F)
      {
        ImGui::SameLine(); ImGui::TextDisabled(" | Updated:"); ImGui::SameLine(); ImGui::Text("%.1fs", secondsSince(m_state->robot.lastUpdate));
        ImGui::SameLine(); ImGui::TextColored(m_state->log.warningCount ? kWarning : kGood, "W:%u", m_state->log.warningCount);
        ImGui::SameLine(); ImGui::TextColored(m_state->log.errorCount ? kDanger : kGood, "E:%u", m_state->log.errorCount);
      }
      ImGui::SameLine(ImGui::GetWindowContentRegionMax().x - 285.0F);
      if(m_state->render.gpuFrameTimeValid)
        ImGui::Text("%ux%u %.1f FPS GPU %.2fms", m_state->render.viewportWidth, m_state->render.viewportHeight, m_state->render.fps, m_state->render.gpuFrameTimeMs);
      else
        ImGui::Text("%ux%u %.1f FPS GPU N/A", m_state->render.viewportWidth, m_state->render.viewportHeight, m_state->render.fps);
      ImGui::EndMenuBar();
    }
    ImGui::End();
  }
}

}  // namespace vk_gaussian_splatting
