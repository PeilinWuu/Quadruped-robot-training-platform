#pragma once

#include <array>
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <mujoco/mujoco.h>
#include <nlohmann/json.hpp>

namespace sidecar {

enum class SimulationState { unloaded, loaded, running, paused, stopped };

struct EngineResult {
  bool ok;
  nlohmann::json payload;
  std::string code;
};

std::array<double, 3> convert_position(const std::array<double, 3>& position);
std::array<double, 4> convert_quaternion_wxyz(const std::array<double, 4>& quaternion);
const char* simulation_state_name(SimulationState state);

class SimulationEngine {
 public:
  using PoseSink = std::function<void(nlohmann::json)>;
  SimulationEngine(std::filesystem::path resource_root, PoseSink pose_sink);
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
  nlohmann::json state_payload_locked() const;
  void step_once_locked();
  void physics_loop();

  const std::filesystem::path resource_root_;
  const PoseSink pose_sink_;
  mutable std::mutex mutex_;
  std::condition_variable condition_;
  bool quitting_{false};
  SimulationState state_{SimulationState::unloaded};
  ModelPtr model_;
  DataPtr data_;
  std::vector<int> joint_qpos_addresses_;
  std::vector<std::string> joint_names_;
  double speed_{1.0};
  std::uint32_t sequence_{0};
  unsigned int control_phase_{0};
  nlohmann::json latest_pose_;
  std::thread physics_thread_;
};

}  // namespace sidecar
