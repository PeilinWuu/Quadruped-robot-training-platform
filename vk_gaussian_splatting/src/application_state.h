/*
 * Lightweight state used by the native monitoring workspace.
 * Vulkan objects and Gaussian scene data remain owned by GaussianSplatting.
 */
#pragma once

#include <array>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <string>

#include <glm/vec3.hpp>
#include <glm/vec2.hpp>

#include "app_actions.h"
#include "ring_buffer.h"

namespace vk_gaussian_splatting {

constexpr std::size_t kTrainingHistoryCapacity    = 800;
constexpr std::size_t kPerformanceHistoryCapacity = 500;
constexpr std::size_t kNavigationPathCapacity     = 1000;
constexpr std::size_t kEventLogCapacity           = 800;

enum class DataSourceKind
{
  Mock,
  Real,
};

enum class ConnectionState
{
  Offline,
  Online,
  Error,
};

enum class SceneLoadState
{
  Empty,
  Loading,
  Ready,
  Failed,
};

enum class SimulationState
{
  Idle,
  Running,
  Paused,
  Stopped,
};

enum class TrainingRunState
{
  Idle,
  Running,
  Paused,
  Stopped,
};

struct ProjectUiState
{
  std::string       projectName{"Quadruped Fire-Rescue Monitor"};
  DataSourceKind    dataSource{DataSourceKind::Mock};
  ConnectionState  connection{ConnectionState::Online};
  SimulationState  simulation{SimulationState::Idle};
};

struct SceneUiState
{
  std::string name{"Office Corridor - 3F"};
  std::string building{"Integrated Office Building"};
  std::string floor{"3F"};
  std::string fireLocation{"East Corridor"};
  std::string riskLevel{"HIGH"};
};

struct EnvironmentMockState
{
  float fireIntensity{68.0F};
  float smokeDensity{65.0F};
  float ambientTemperature{62.0F};
  float obstacleDensity{32.0F};
};

struct RobotState
{
  DataSourceKind                           source{DataSourceKind::Mock};
  ConnectionState                         connection{ConnectionState::Online};
  ControlMode                             requestedControlMode{ControlMode::Autonomous};
  ControlMode                             appliedControlMode{ControlMode::Autonomous};
  CommandStatus                           commandStatus{CommandStatus::Idle};
  float                                   batteryPercent{78.0F};
  float                                   linearVelocity{0.85F};
  float                                   angularVelocity{0.04F};
  glm::vec3                               position{23.5F, 14.2F, 0.28F};
  glm::vec3                               orientationRpy{0.0F, 0.0F, 0.35F};
  std::chrono::steady_clock::time_point   lastUpdate{};
};

struct SensorState
{
  DataSourceKind                           source{DataSourceKind::Mock};
  float                                    temperatureC{62.3F};
  float                                    smokeDensity{0.65F};
  float                                    visibilityMeters{3.8F};
  float                                    oxygenPercent{18.6F};
  ConnectionState                          lidar{ConnectionState::Online};
  ConnectionState                          rgbCamera{ConnectionState::Online};
  ConnectionState                          depthCamera{ConnectionState::Online};
  std::chrono::steady_clock::time_point    lastUpdate{};
};

struct TrainingState
{
  DataSourceKind                           source{DataSourceKind::Mock};
  std::string                              taskName{"Search target and return"};
  TrainingRunState                         state{TrainingRunState::Idle};
  CommandStatus                            commandStatus{CommandStatus::Idle};
  uint32_t                                 episode{0};
  uint32_t                                 step{0};
  float                                    reward{0.0F};
  float                                    loss{0.82F};
  float                                    successRate{0.0F};
  std::chrono::steady_clock::duration      elapsed{};
  std::chrono::steady_clock::time_point    lastUpdate{};
};

struct TrainingSample
{
  double   timestamp{0.0};
  uint32_t episode{0};
  float    reward{0.0F};
  float    policyLoss{0.0F};
  float    valueLoss{0.0F};
  float    successRate{0.0F};
};

using TrainingHistory = RingBuffer<TrainingSample, kTrainingHistoryCapacity>;

struct PerformanceSample
{
  double timestamp{0.0};
  float  fps{0.0F};
  float  gpuFrameTimeMs{0.0F};
  float  cpuUiTimeMs{0.0F};
  float  gpuMemoryMb{0.0F};
  bool   fpsValid{false};
  bool   gpuFrameTimeValid{false};
  bool   cpuUiTimeValid{false};
  bool   gpuMemoryValid{false};
};

using PerformanceHistory = RingBuffer<PerformanceSample, kPerformanceHistoryCapacity>;

enum class NavigationTool
{
  Inspect,
  SetTarget,
};

struct MapArea
{
  glm::vec2 min{};
  glm::vec2 max{};
};

struct NavigationState
{
  glm::vec2                                             robotPosition2D{23.5F, 14.2F};
  float                                                 robotHeading{0.35F};
  RingBuffer<glm::vec2, kNavigationPathCapacity>        pathPoints;
  glm::vec2                                             targetPoint{};
  bool                                                  targetValid{false};
  std::array<MapArea, 4>                                obstacleAreas{{{{18.0F, 9.0F}, {21.0F, 13.0F}},
                                                                        {{27.0F, 16.0F}, {31.0F, 19.0F}},
                                                                        {{10.0F, 20.0F}, {14.0F, 23.0F}},
                                                                        {{34.0F, 7.0F}, {37.0F, 12.0F}}}};
  std::array<MapArea, 2>                                fireRiskAreas{{{{24.0F, 12.0F}, {30.0F, 17.0F}},
                                                                        {{7.0F, 25.0F}, {12.0F, 30.0F}}}};
  float                                                 mapZoom{16.0F};
  glm::vec2                                             mapPan{};
  NavigationTool                                        tool{NavigationTool::Inspect};
  bool                                                  mock{true};
};

enum class LogSeverity
{
  Debug,
  Info,
  Warning,
  Error,
};

struct LogEntry
{
  uint64_t       sequence{0};
  double         timestamp{0.0};
  LogSeverity    severity{LogSeverity::Info};
  std::string    category;
  std::string    message;
};

struct LogState
{
  RingBuffer<LogEntry, kEventLogCapacity> entries;
  std::array<bool, 4>                     severityVisible{{true, true, true, true}};
  std::string                             categoryFilter;
  bool                                    autoScroll{true};
  bool                                    showTimestamp{true};
  uint32_t                                errorCount{0};
  uint32_t                                warningCount{0};
  uint64_t                                nextSequence{1};
};

struct UiState
{
  bool showProjectStatus{true};
  bool showSceneEnvironment{true};
  bool showRobotSensors{true};
  bool showTrainingMonitor{true};
  bool showStatusBar{true};
  bool showTrainingCharts{true};
  bool showPerformanceCharts{true};
  bool showNavigationMap{true};
  bool showEventLog{true};
  bool requestMonitoringLayoutReset{false};
};

struct RenderStatusView
{
  std::filesystem::path sceneFilename;
  SceneLoadState        loadState{SceneLoadState::Empty};
  uint64_t              gaussianCount{0};
  std::string           pipelineName{"Unknown"};
  uint32_t              viewportWidth{0};
  uint32_t              viewportHeight{0};
  float                 fps{0.0F};
  float                 gpuFrameTimeMs{0.0F};
  float                 cpuUiTimeMs{0.0F};
  float                 gpuMemoryMb{0.0F};
  bool                  gpuFrameTimeValid{false};
  bool                  cpuUiTimeValid{false};
  bool                  gpuMemoryValid{false};
};

struct ApplicationState
{
  ProjectUiState        project;
  SceneUiState          scene;
  EnvironmentMockState environment;
  RobotState            robot;
  SensorState           sensors;
  TrainingState         training;
  TrainingHistory       trainingHistory;
  PerformanceHistory    performanceHistory;
  NavigationState       navigation;
  LogState              log;
  UiState               ui;
  RenderStatusView      render;
};

const char* toString(DataSourceKind value);
const char* toString(ConnectionState value);
const char* toString(SceneLoadState value);
const char* toString(SimulationState value);
const char* toString(TrainingRunState value);
const char* toString(ControlMode value);
const char* toString(CommandStatus value);

}  // namespace vk_gaussian_splatting
