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
enum class EventKind { pose, telemetry, motion_command, telemetry_config, collision };

enum class CollisionCategory { feet, calves, thighs, hips, torso, head, other_robot, environment };

struct EnvironmentMetadata {
  std::string id{"flat-ground-v1"};
  std::string display_name{"纯平地演示场景"};
  double floor_height{0.0};
  double half_extent{10.0};
  double demo_boundary_half_extent{8.0};
  std::array<double, 3> spawn_position{};
  std::array<double, 4> spawn_orientation{{0.0, 0.0, 0.0, 1.0}};
  std::array<double, 3> friction{{0.9, 0.1, 0.01}};
  std::array<double, 2> solref{{0.02, 1.0}};
  std::array<double, 3> solimp{{0.9, 0.95, 0.001}};
};

const EnvironmentMetadata& flat_ground_environment();
const char* collision_category_name(CollisionCategory category);

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

  EngineResult load_model(const std::string& model_id,
                          const std::string& environment_id = "flat-ground-v1");
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
#ifdef SIDECAR_TESTING
  [[nodiscard]] nlohmann::json test_collision_profile() const;
  [[nodiscard]] nlohmann::json test_model_profile() const;
  [[nodiscard]] nlohmann::json test_locomotion_profile() const;
  [[nodiscard]] nlohmann::json test_locomotion_diagnostics() const;
  [[nodiscard]] nlohmann::json test_static_mpc_diagnostics() const;
  [[nodiscard]] nlohmann::json test_performance_window(double wall_elapsed_seconds,
                                                        double simulation_elapsed_seconds,
                                                        std::uint64_t physics_steps);
  [[nodiscard]] bool test_has_stable_performance_snapshot() const;
  bool test_set_root_state(const std::array<double, 3>& position,
                           const std::array<double, 4>& quaternion_wxyz);
#endif
  void shutdown();

 private:
  struct ModelDeleter { void operator()(mjModel* value) const noexcept; };
  struct DataDeleter { void operator()(mjData* value) const noexcept; };
  struct ControllerRuntime;
  using ModelPtr = std::unique_ptr<mjModel, ModelDeleter>;
  using DataPtr = std::unique_ptr<mjData, DataDeleter>;

  EngineResult invalid_state() const;
  nlohmann::json pose_locked(bool advance_sequence);
  nlohmann::json telemetry_locked(bool advance_sequence, bool refresh_performance = true);
  nlohmann::json performance_locked(std::chrono::steady_clock::time_point now,
                                    double simulation_time, bool active);
  nlohmann::json collision_telemetry_locked();
  nlohmann::json motion_status_locked() const;
  nlohmann::json state_payload_locked() const;
  void clear_motion_locked();
  void reset_statistics_locked();
  void update_command_timeout_locked();
  void reset_locomotion_locked();
  std::array<double, 3> foot_position_locked(const mjData* data, std::size_t leg) const;
  nlohmann::json locomotion_telemetry_locked() const;
  void apply_joint_pd_locked();
  void step_once_locked();
  void update_collision_state_locked();
  std::vector<nlohmann::json> take_collision_events_locked();
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
  std::unique_ptr<ControllerRuntime> controller_runtime_;
  std::string model_id_;
  std::string environment_id_{"flat-ground-v1"};
  std::vector<int> joint_ids_;
  std::vector<int> joint_qpos_addresses_;
  std::vector<int> joint_dof_addresses_;
  std::vector<int> actuator_ids_;
  std::vector<std::string> joint_names_;
  std::array<int, 4> foot_geom_ids_{{-1, -1, -1, -1}};
  std::array<int, 4> foot_body_ids_{{-1, -1, -1, -1}};
  int ground_geom_id_{-1};
  std::vector<CollisionCategory> geom_categories_;
  std::vector<std::string> geom_profile_names_;
  int root_body_id_{-1};
  int imu_site_id_{-1};
  std::vector<double> home_joint_positions_;
  std::vector<double> joint_targets_;
  int home_keyframe_{-1};
  bool test_pose_hold_{false};
  double speed_{1.0};
  std::uint32_t pose_sequence_{0};
  std::uint32_t telemetry_sequence_{0};
  unsigned int control_phase_{0};
  nlohmann::json latest_pose_;
  nlohmann::json latest_telemetry_;
  nlohmann::json latest_collision_;
  std::vector<nlohmann::json> pending_collision_events_;
  bool non_foot_collision_active_{false};
  bool fallen_{false};
  bool out_of_bounds_{false};
  double fall_candidate_since_{-1.0};
  double last_impact_time_{-1.0};
  double fall_height_threshold_{0.16};
  double fall_orientation_threshold_{0.9599310885968813};
  double impact_threshold_{180.0};
  MotionCommand motion_command_;
  std::chrono::steady_clock::time_point motion_received_at_{};
  bool motion_timed_out_{false};
  std::uint64_t joint_limit_clip_count_{0};
  std::uint64_t saturation_count_{0};
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
