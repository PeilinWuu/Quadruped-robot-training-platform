#pragma once

#include <array>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include <mujoco/mujoco.h>
#include <nlohmann/json.hpp>

namespace sidecar {

enum class SimulationState { unloaded, loaded, running, paused, stopped };
enum class MotionMode { stand, locomotion };
enum class EventKind { pose, telemetry, motion_command, telemetry_config };

struct MotionCommand {
  std::uint32_t sequence{0};
  MotionMode mode{MotionMode::stand};
  double forward_velocity{0.0};
  double lateral_velocity{0.0};
  double yaw_rate{0.0};
  double body_height{0.30};
  std::uint32_t valid_for_ms{500};
};

struct EngineResult {
  bool ok;
  nlohmann::json payload;
  std::string code;
};

std::array<double, 3> convert_position(const std::array<double, 3>& position);
std::array<double, 4> convert_quaternion_wxyz(const std::array<double, 4>& quaternion);
const char* simulation_state_name(SimulationState state);
bool valid_motion_command(const MotionCommand& command);

class SimulationEngine {
 public:
  using EventSink = std::function<bool(EventKind, nlohmann::json)>;
  using LegacyPoseSink = std::function<void(nlohmann::json)>;
  SimulationEngine(std::filesystem::path resource_root, EventSink event_sink);
  SimulationEngine(std::filesystem::path resource_root, LegacyPoseSink pose_sink);
  ~SimulationEngine();
  SimulationEngine(const SimulationEngine&) = delete;
  SimulationEngine& operator=(const SimulationEngine&) = delete;

  EngineResult load_model(const std::string& model_id);
  EngineResult start();
  EngineResult pause();
  EngineResult step(int steps);
  EngineResult reset();
  EngineResult stop();
  EngineResult set_speed(double speed);
  EngineResult set_motion_command(const MotionCommand& command);
  EngineResult clear_motion_command();
  EngineResult set_telemetry_rate(int hz);
  EngineResult get_latest_telemetry();
  [[nodiscard]] SimulationState state() const;
  [[nodiscard]] nlohmann::json latest_pose() const;
  void shutdown();

 private:
  struct ModelDeleter { void operator()(mjModel* value) const noexcept; };
  struct DataDeleter { void operator()(mjData* value) const noexcept; };
  using ModelPtr = std::unique_ptr<mjModel, ModelDeleter>;
  using DataPtr = std::unique_ptr<mjData, DataDeleter>;

  EngineResult invalid_state() const;
  nlohmann::json pose_locked(bool advance_sequence);
  nlohmann::json telemetry_locked(bool advance_sequence, bool refresh_performance = true);
  nlohmann::json motion_status_locked() const;
  nlohmann::json state_payload_locked() const;
  void clear_motion_locked();
  void reset_statistics_locked();
  void update_command_timeout_locked();
  void step_once_locked();
  void physics_loop();
  void publish(EventKind kind, nlohmann::json payload);

  const std::filesystem::path resource_root_;
  const EventSink event_sink_;
  mutable std::mutex mutex_;
  std::condition_variable condition_;
  bool quitting_{false};
  SimulationState state_{SimulationState::unloaded};
  ModelPtr model_;
  DataPtr data_;
  std::string model_id_;
  std::vector<int> joint_ids_;
  std::vector<int> joint_qpos_addresses_;
  std::vector<int> joint_dof_addresses_;
  std::vector<int> actuator_ids_;
  std::vector<std::string> joint_names_;
  std::array<int, 4> foot_geom_ids_{{-1, -1, -1, -1}};
  int root_body_id_{-1};
  int imu_site_id_{-1};
  std::vector<double> home_joint_positions_;
  int home_keyframe_{-1};
  bool test_pose_hold_{false};
  double speed_{1.0};
  std::uint32_t pose_sequence_{0};
  std::uint32_t telemetry_sequence_{0};
  unsigned int control_phase_{0};
  nlohmann::json latest_pose_;
  nlohmann::json latest_telemetry_;
  MotionCommand motion_command_;
  std::chrono::steady_clock::time_point motion_received_at_{};
  bool motion_timed_out_{false};
  int telemetry_rate_hz_{50};

  std::chrono::steady_clock::time_point stats_started_at_{};
  double stats_simulation_started_{0.0};
  std::uint64_t physics_steps_{0};
  std::uint64_t control_steps_{0};
  std::uint64_t pose_publishes_{0};
  std::uint64_t telemetry_publishes_{0};
  std::uint64_t dropped_pose_events_{0};
  std::uint64_t dropped_telemetry_events_{0};
  std::uint64_t catch_up_steps_{0};
  double physics_step_total_ms_{0.0};
  double physics_step_max_ms_{0.0};
  double control_step_total_ms_{0.0};
  double control_step_max_ms_{0.0};
  nlohmann::json performance_snapshot_;
  std::thread physics_thread_;
};

}  // namespace sidecar
